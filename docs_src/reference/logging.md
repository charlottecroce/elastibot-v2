# Logging and Errors

Everything logs through `src/util/logger.js` rather than `console.*`, so output has consistent structure, secrets get redacted before they can reach a log sink, and noise can be turned down per environment with one env var.

`util/logger` requires nothing. It's the bottom of the dependency tree.

## Log records

```js
const { logger } = require('./util/logger');
const log = logger.child({ scope: 'watcher:alerts' });

log.info('posted incident', { channel, count: 3 });
log.error('post failed', { err });   // `err` is serialized specially
```

Levels: `trace` < `debug` < `info` < `warn` < `error` < `fatal` < `silent`.

Child loggers carry their fields down, which is how every line for one Slack interaction ends up tagged with the same `scope`, `traceId` and `slackUserId`.

Two formats: `pretty` and `json`.

A convention worth following: warnings and errors that an operator can act on carry a `remedy` field naming the thing to change.

```
poll hit the fetch ceiling - alerts may arrive faster than they are posted
  fetchSize=200 remedy="raise WATCH_FETCH_SIZE or lower WATCH_POLL_MS"
```

## Redaction


Field names that look secret get replaced wholesale. Anything matching `api_key`, `token`, `secret`, `password`, `authorization`, `credential`, `encryptionkey`, `signing`.

Secret-looking values inside otherwise innocent strings (a URL, an error message, a stack trace) get pattern-matched out:

- `xox[baprs]-…` and `xapp-…` Slack tokens
- `ApiKey <blob>` Authorization header values
- `enc:<blob>`, Elastibot's own at-rest ciphertext

Beyond that, some call sites deliberately don't log things at all. The `/start` auto-provision path never logs the admin username, the admin password, or any part of the key it created, only the key's id and name.

## Trace IDs

The registrar mints an 8-character `traceId` for every command, button and modal submission. It goes on every log line for that interaction, and on unexpected errors it's echoed to the analyst:

```
:x: Something went wrong on my end (ref `a1b2c3d4`).
```

So an analyst can just `grep a1b2c3d4` and make finding the exact error log a bit easier.

## User-facing vs unexpected errors

`src/util/errors.js` draws one line, and `handleHandlerError` acts on it.

**`UserFacingError`** is bad input, a missing alert, a rejected key, etc. Logged at `info` as `request rejected`, and the message goes straight to the analyst because it's something they can act on. If the command declared a `userErrorSuffix` (usually its usage string), that gets appended.

**Anything else** is a defect or a dependency failure. Full detail goes to the log at `error`; the analyst gets the trace reference and nothing else, because the real message is frequently an internal hostname:

```
log:   handler failed  err="ECONNREFUSED 10.0.0.5:9200"
slack: :x: Something went wrong on my end (ref `bbbb2222`).
```

`describeAxiosError(err, context)` is what turns HTTP failures into the first kind, with a message that names the fix:

| condition | message |
| --- | --- |
| 401 / 403 | Elastic rejected your API key — re-run `/start` |
| 404 | not found, plus whatever reason Elastic gave |
| 429 | Elastic is rate limiting us, try again shortly |
| `ECONNABORTED` / `ETIMEDOUT` | Elastic didn't answer in time |
| `ECONNREFUSED` / `ENOTFOUND` | couldn't reach Elastic — check `KIBANA_URL` / `ELASTICSEARCH_URL` |
| TLS errors | names `ELASTIC_TLS_REJECT_UNAUTHORIZED` and the install-the-CA alternative |

Replying can't throw a second error on top of the first. If Slack itself is what's broken, that gets logged and the handler moves on rather than unwinding into Bolt.

Above all that sit two catch-alls: Bolt's own error handler for anything escaping the registrar (middleware, deserialization), and process-level handlers for unhandled rejections and uncaught exceptions.

## Retries

`src/util/retry.js` installs an axios interceptor on both the ES and Kibana clients. The policy is narrow on purpose:

- **reads only.** A write is never retried however transient the failure looks. A duplicate case is worse than a failed one.
- **transient statuses only**: 429, 502, 503, 504, and timeouts. A 404 isn't retried, because it won't stop being a 404.
- exponential backoff from `ELASTIC_RETRY_BASE_MS`, unless the response carries a `Retry-After`, which wins.
- budget is `ELASTIC_RETRIES`. When it's spent, the original error is rejected unchanged so `describeAxiosError` still sees the real thing.

The retry counter lives on the axios config object, which is shared across attempts of the same request.

`(ELASTIC_RETRIES + 1) × ELASTIC_TIMEOUT_MS`. If that's at or above
`WATCH_POLL_MS`, the runner's overlap guard starts skipping ticks, and
`validateConfig` warns about exactly that at boot.