# Architecture

## Repository layout

```
app.js                 bootstrap only
config/
  index.js             every setting, with defaults. edit this for a deployment
  validate.js          boot-time checks, errors and warnings
manifest.yml           Slack app definition
api_permissions/       role descriptors for analyst and service API keys
src/
  constants.js         ids that have to match across module boundaries
  context.js           everything with a lifetime longer than one request
  elastic.js           thin HTTP client over Elasticsearch + Kibana
  grouping.js          alerts > incidents
  incidents.js         the incident store (persisted)
  store.js             UserStore, StateStore, JsonFileStore
  naming.js            case title scheme
  commands/            one file per slash command, auto-discovered
  slack/registrar.js   one wrapper around every Slack entry point
  services/            case creation, stats, block kits, links, rendering
  watchers/            the polling loop
  util/                logger, errors, crypto, retry, cache, atomic writes
tests/                 jest, fully mocked
docs_src/              these docs (mkdocs source)
docs/                  built site, committed by CI
```

## Startup

`app.js` does nothing but wire things up, in this order:

```
logging → process handlers → config validation → context → slack app
        → commands → watchers → shutdown handlers
```

The order matters in a few places:

- **Logging first**, so the config warnings that come next honour the operator's chosen level and format. `util/logger` depends on nothing and reads env vars for a default before `configure()` gets called with the real config.
- **Process handlers next**. An unhandled rejection is logged and survived; one bad watcher tick shouldn't take the bot
- **Config validation before anything connects.** `validateConfig` throws a `ConfigError` listing every problem at once.
- **Watchers last**, after `app.start()`, because they need a live Slack client.

## The application context

`createContext()` builds the objects that outlive a single request and hands them
to both the command registrar and the watchers:

| | |
| --- | --- |
| `users` | `UserStore` - Slack user ID -> encrypted Elastic API key |
| `state` | `StateStore` - watcher cursors |
| `incidents` | `IncidentStore` - posted incidents, their cases, their claims |
| `spaces` | space-name cache, shared with `caseService` |
| `log` | scoped logger |
| `close()` | flush the stores, drop decrypted keys from memory |

It's important to note that the watchers and the button handlers get the same `incidents` instance. If they didn't, the watcher would post a second message for a burst the button handlers already have a case for.

All three stores are write-through. A buffered cursor is only ever as good as the last flush, and anything that copies `data/` out from under a live process captures a `state.json` older than what's actually been posted. Restoring that rewinds the cursor onto alerts already in the channel and posts them twice.

## Process Flow

**Inbound from Slack** (a command or a button click):

```
Slack → registrar → command module → service → elastic client → ES / Kibana
                        ↓
                  incident store → renderIncident → chat.update
```

`src/slack/registrar.js` wraps every entry point, so a regression there is a regression everywhere at once. It handles:

- acking before the handler runs (Slack times out fast). A failed ack stops the handler, since there's nothing left to reply to
- a `traceId` on every log line for that interaction, echoed to the user on unexpected errors
- the "have you run `/start`" gate, when `requireUser` is set
- argument counting against `minArgs`, showing `usage` instead of calling the handler
- a uniform `reply.ephemeral()` / `reply.inChannel()` surface, so a handler doesn't care whether it's in a command (which has `respond`) or an action (which posts through the web client)
- error translation - see [Logging and Errors](../reference/logging.md)

Views are the exception to auto-acking: they ack with a `response_action`, so they own it. If a view handler forgets, the registrar acks anyway, otherwise the modal spins on the analyst's screen until Slack gives up.

**Outbound from the timer** (a watcher tick):

```
runner → pollAlerts → elastic.getAlertsSince → groupAlerts
                          ↓
                  incidents.findMatch → post or update → Slack
       → pollCases  → elastic.findRecentCases → post
```

Details in [The Watchers](watchers.md).

## Shutdown

`SIGINT`/`SIGTERM` triggers a graceful path: stop the watchers, stop the Bolt app, close the context. Watchers stop *first* so the cursor written to disk is final and not overwritten by a tick that's still finishing.

A hard-exit timer (`SHUTDOWN_TIMEOUT_MS`, 15s) sits over the whole thing so a hung dependency can't keep the process alive forever. The handler is declared before `app.start()`, so a `SIGTERM` during startup still takes the graceful path.