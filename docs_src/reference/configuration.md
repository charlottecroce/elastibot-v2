# Configuration

## Settings files

- **`.env`** - secrets only. Gitignored. Copy `.env.example`.
- **`config/index.js`** - every setting, with a default for each. This is the file you edit for a deployment (other than `.env`). Most values read an env var and fall back, so you can override from either side.

A few things only exist in `config/index.js` because they're structured rather than scalar - `channelRouting` most notably.

Env parsing helpers (`bool`, `int`, `num`, `list`) throw on malformed input. An empty string falls back to the default rather than being treated as a value.

## Validation at boot

`config/validate.js` runs before anything connects. It throws a `ConfigError` listing **everything** that's wrong, so you fix it all in one pass.

It also emits warnings for things that are legal but suspicious, including some that are computed rather than looked up:

- worst-case Elastic call duration `(ELASTIC_RETRIES + 1) × ELASTIC_TIMEOUT_MS` at or above `WATCH_POLL_MS`, which means ticks get skipped under load
- `WATCH_POLL_MS` under 5s - more load for no benefit
- `WATCH_POST_DELAY_MS` under 100 - a burst of 50 incidents is a guaranteed 429

## Slack

| Var | Default | |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | — | required, `xoxb-` |
| `SLACK_SIGNING_SECRET` | — | required |
| `SLACK_APP_TOKEN` | — | required in Socket Mode, `xapp-` |
| `SLACK_SOCKET_MODE` | `true` | `false` runs an HTTP server instead |
| `PORT` | `3000` | only used when Socket Mode is off |

## Elastic

| Var | Default | |
| --- | --- | --- |
| `KIBANA_URL` | — | required. the endpoint **the bot** calls |
| `KIBANA_PUBLIC_URL` | `KIBANA_URL` | the endpoint **a browser** reaches. all Slack links use this |
| `ELASTICSEARCH_URL` | — | required |
| `ELASTIC_SERVICE_API_KEY` | — | encoded key for the watchers and space lookups |
| `ALERTS_INDEX` | `.alerts-security.alerts-*` | |
| `DEFAULT_CASE_OWNER` | `securitySolution` | fallback when it can't be derived from the alert |
| `ELASTIC_TLS_REJECT_UNAUTHORIZED` | `true` | `false` for a self-signed internal cluster |
| `ELASTIC_TIMEOUT_MS` | `15000` | |
| `ELASTIC_RETRIES` | `2` | reads only. writes are never retried |
| `ELASTIC_RETRY_BASE_MS` | `250` | |
| `ELASTIC_MAX_SOCKETS` | `50` | keep-alive pool per host |
| `ELASTIC_MAX_RESPONSE_BYTES` | `52428800` | |

`analystRoleDescriptors` is `require`d straight from `api_permissions/elastibot_analyst.json`, so the automatic and manual key-creation paths can't drift apart.

## Watchers and routing

| Var | Default | |
| --- | --- | --- |
| `WATCHERS_ENABLED` | `true` | |
| `WATCH_POLL_MS` | `60000` | |
| `WATCH_JITTER_RATIO` | `0.1` | ±10% per interval, so replicas don't sync up |
| `WATCH_FETCH_SIZE` | `200` | keep above a plausible burst size |
| `WATCH_POST_DELAY_MS` | `300` | Slack rate-limit courtesy |
| `DEFAULT_CHANNEL` | — | e.g. `C0123456789` |
| `WATCH_ALERTS_ENABLED` | `true` | |
| `WATCH_CASES_ENABLED` | `true` | |
| `WATCH_CASE_SPACES` | `default` | comma-separated space IDs |
| `WATCH_CASES_PER_PAGE` | `25` | page size for the Cases `_find` call |

Per-space routing is a plain object in `config/index.js`:

```js
channelRouting: {
  'soc': 'C0123456789',
},
```

Anything unmatched falls through to `DEFAULT_CHANNEL`.

## Grouping and incidents

| Var | Default | |
| --- | --- | --- |
| `GROUP_WINDOW_MS` | `3600000` | 1h. window measured from the first alert |
| `GROUP_MERGE_MACHINE_USERS` | `true` | pass 2 on/off |
| `GROUP_MACHINE_USERS` | see below | comma-separated, globs allowed |
| `GROUP_MAX_ALERTS` | | ceiling on alerts folded into one case |
| `INCIDENT_IDLE_MS` | `28800000` | 8h. no new alerts for this long → reaped |
| `INCIDENT_MAX_LIFETIME_MS` | `86400000` | 24h hard ceiling regardless of activity |
| `INCIDENT_CLAIM_TTL_MS` | `60000` | how long a create-case claim is honoured |

Default machine-user list:

```
SYSTEM, LOCAL SERVICE, NETWORK SERVICE, LOCAL SYSTEM, ANONYMOUS LOGON,
root, daemon, nobody, svc_*, svc-*, sa_*, _*
```

This is the one setting here that's specific to your environment's naming conventions. The default is a reasonable starting point.

`INCIDENT_IDLE_MS` is worth thinking about. It's the thing that decides how long a burst can spread out and still be one message with one case. A shift length is about right.

## Stats

| Var | Default | |
| --- | --- | --- |
| `STATS_DEFAULT_WINDOW` | `7d` | |
| `STATS_MAX_WINDOW_DAYS` | `90` | hard cap |
| `STATS_TIMEZONE` | `UTC` | set it to your SOC's zone |
| `STATS_TOP_N` | `10` | entries per "top N" list |
| `STATS_NOISE_MIN_ALERTS` | `10` | floor before a rule can be called noisy |
| `STATS_PROCESS_FIELD` | `process.name` | override if your alerts map it elsewhere |

`STATS_PROCESS_FIELD` is the field most likely to need changing. If a terms aggregation complains about fielddata, the field is `text` in your mapping and needs a `.keyword` suffix.

## Security and storage

| Var | Default | |
| --- | --- | --- |
| `ELASTIBOT_SECRET_KEY` | — | 32+ chars. `openssl rand -hex 16` |
| `AUTO_PROVISION_SLACK_IDS` | empty | Slack IDs allowed to use `/start`'s auto-key option |
| `USER_STORE_PATH` | `./data/users.json` | |
| `STATE_PATH` | `./data/state.json` | |
| `INCIDENT_STORE_PATH` | `./data/incidents.json` | |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | before a hard exit |

## Caching

| Var | Default |
| --- | --- |
| `USER_CACHE_TTL_MS` | `300000` |
| `ELASTIC_CLIENT_TTL_MS` | `900000` |
| `ELASTIC_MAX_CLIENTS` | `250` |
| `SPACE_NAME_TTL_MS` | `3600000` |

## Logging

| Var | Default | |
| --- | --- | --- |
| `LOG_LEVEL` | `info` in prod, `debug` otherwise, `silent` in tests | `trace`…`fatal`, `silent` |
| `LOG_FORMAT` | `json` in prod, `pretty` otherwise | |
| `LOG_REDACT` | `true` | leave it on |

`LOG_REDACT` exists to debug the redactor itself. Never turn it off in production. See [Logging and Errors](logging.md).