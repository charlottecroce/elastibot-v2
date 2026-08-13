# Configuration

## The settings file

Every setting lives in `elastibot.yml`, secrets included. Gitignored

```bash
cp elastibot.example.yml elastibot.yml
chmod 600 elastibot.yml
```

The file holds three Slack tokens, the Elastic service API key and the key that encrypts analysts' stored credentials at rest. Elastibot checks the mode at boot and warns if it's readable by anyone but its owner.

Every setting appears in `elastibot.yml`, with its default, a comment on what it's for, and the name of its environment variable. The tables below are a quick index rather than a substitute for reading it.

Five settings are required: the three Slack secrets, `elastic.kibana_url` and `elastic.elasticsearch_url`. Everything else has a default, so deleting a section you're happy with is a viable way of using the file.

## Where a setting comes from

Highest priority first:

1. `elastibot.yml`
2. an environment variable
3. the built-in default in `config/index.js`

## Writing the file

Nested and dotted keys are the same thing, as in `elasticsearch.yml`:

```yaml
elastic:
  timeout_ms: 15000

# identical to
elastic.timeout_ms: 15000
```

If your deployment already injects secrets into the environment, you can reference them instead of writing them down a second time:

```yaml
slack:
  bot_token: ${SLACK_BOT_TOKEN}
  app_token: ${SLACK_APP_TOKEN:none}   # ${VAR:fallback}
```

An unset `${VAR}` with no fallback is treated as *not configured* rather than as an error, so it falls through to the default and, if the setting is required, gets reported by the normal boot validation. A `${VAR}` that resolves is not counted as the file shadowing that variable, for the obvious reason.

`ELASTIBOT_CONFIG` points at a file somewhere other than `./elastibot.yml`.

## Validation at boot

`config/validate.js` runs before anything connects. It throws a `ConfigError` listing **everything** that's wrong, so you fix it all in one pass.

It also emits warnings for things that are legal but suspicious, including some that are computed rather than looked up:

- `elastibot.yml` being readable by anyone other than its owner
- a setting present in both `elastibot.yml` and the environment
- worst-case Elastic call duration `(retries + 1) × timeout_ms` at or above `watchers.poll_ms`, which means ticks get skipped under load
- `watchers.poll_ms` under 5s - more load for no benefit
- `watchers.post_delay_ms` under 100 - a burst of 50 incidents is a guaranteed 429

## Slack

| Key | Env | Default | |
| --- | --- | --- | --- |
| `slack.bot_token` | `SLACK_BOT_TOKEN` | — | required, `xoxb-` |
| `slack.signing_secret` | `SLACK_SIGNING_SECRET` | — | required |
| `slack.app_token` | `SLACK_APP_TOKEN` | — | required in Socket Mode, `xapp-` |
| `slack.socket_mode` | `SLACK_SOCKET_MODE` | `true` | `false` runs an HTTP server instead |
| `slack.port` | `PORT` | `3000` | only used when Socket Mode is off |

## Elastic

| Key | Env | Default | |
| --- | --- | --- | --- |
| `elastic.kibana_url` | `KIBANA_URL` | — | required. the endpoint **the bot** calls |
| `elastic.kibana_public_url` | `KIBANA_PUBLIC_URL` | `kibana_url` | the endpoint **a browser** reaches. all Slack links use this |
| `elastic.elasticsearch_url` | `ELASTICSEARCH_URL` | — | required |
| `elastic.service_api_key` | `ELASTIC_SERVICE_API_KEY` | — | encoded key for the watchers and space lookups |
| `elastic.alerts_index` | `ALERTS_INDEX` | `.alerts-security.alerts-*` | |
| `elastic.default_case_owner` | `DEFAULT_CASE_OWNER` | `securitySolution` | fallback when it can't be derived from the alert |
| `elastic.tls_reject_unauthorized` | `ELASTIC_TLS_REJECT_UNAUTHORIZED` | `true` | `false` for a self-signed internal cluster |
| `elastic.timeout_ms` | `ELASTIC_TIMEOUT_MS` | `15000` | |
| `elastic.retries` | `ELASTIC_RETRIES` | `2` | reads only. writes are never retried |
| `elastic.retry_base_ms` | `ELASTIC_RETRY_BASE_MS` | `250` | |
| `elastic.max_sockets` | `ELASTIC_MAX_SOCKETS` | `50` | keep-alive pool per host |
| `elastic.max_response_bytes` | `ELASTIC_MAX_RESPONSE_BYTES` | `52428800` | |
| `elastic.analyst_role_descriptors_path` | `ANALYST_ROLE_DESCRIPTORS_PATH` | `api_permissions/elastibot_analyst.json` | |

The role descriptors are read from the same file an admin would otherwise paste into `POST /_security/api_key` by hand, so the automatic and manual key-creation paths can't drift apart.

## Watchers and routing

| Key | Env | Default | |
| --- | --- | --- | --- |
| `watchers.enabled` | `WATCHERS_ENABLED` | `true` | |
| `watchers.poll_ms` | `WATCH_POLL_MS` | `60000` | |
| `watchers.jitter_ratio` | `WATCH_JITTER_RATIO` | `0.1` | ±10% per interval, so replicas don't sync up |
| `watchers.fetch_size` | `WATCH_FETCH_SIZE` | `200` | keep above a plausible burst size |
| `watchers.post_delay_ms` | `WATCH_POST_DELAY_MS` | `300` | Slack rate-limit courtesy |
| `watchers.default_channel` | `DEFAULT_CHANNEL` | — | e.g. `C0123456789` |
| `watchers.alerts.enabled` | `WATCH_ALERTS_ENABLED` | `true` | |
| `watchers.cases.enabled` | `WATCH_CASES_ENABLED` | `true` | |
| `watchers.cases.spaces` | `WATCH_CASE_SPACES` | `[default]` | space IDs |
| `watchers.cases.per_page` | `WATCH_CASES_PER_PAGE` | `25` | page size for the Cases `_find` call |

Per-space routing is a mapping.

```yaml
watchers:
  channel_routing:
    soc-1: C0123456789
    soc-2: C0987654321
```

Anything unmatched falls through to `default_channel`.

## Grouping and incidents

| Key | Env | Default | |
| --- | --- | --- | --- |
| `grouping.window_ms` | `GROUP_WINDOW_MS` | `3600000` | 1h. window measured from the first alert |
| `grouping.merge_machine_users` | `GROUP_MERGE_MACHINE_USERS` | `true` | pass 2 on/off |
| `grouping.machine_users` | `GROUP_MACHINE_USERS` | see below | globs allowed |
| `grouping.max_alerts` | `GROUP_MAX_ALERTS` | `200` | ceiling on alerts folded into one case |
| `incidents.idle_ms` | `INCIDENT_IDLE_MS` | `28800000` | 8h. no new alerts for this long → reaped |
| `incidents.max_lifetime_ms` | `INCIDENT_MAX_LIFETIME_MS` | `86400000` | 24h hard ceiling regardless of activity |
| `incidents.claim_ttl_ms` | `INCIDENT_CLAIM_TTL_MS` | `60000` | how long a create-case claim is honoured |

Default machine-user list:

```
SYSTEM, LOCAL SERVICE, NETWORK SERVICE, LOCAL SYSTEM, ANONYMOUS LOGON,
root, daemon, nobody, svc_*, svc-*, sa_*, _*
```

This is the one setting here that's specific to your environment's naming conventions. The default is a reasonable starting point.

`incidents.idle_ms` is worth thinking about. It's the thing that decides how long a burst can spread out and still be one message with one case. A shift length is about right.

## Stats

| Key | Env | Default | |
| --- | --- | --- | --- |
| `stats.default_window` | `STATS_DEFAULT_WINDOW` | `7d` | |
| `stats.max_window_days` | `STATS_MAX_WINDOW_DAYS` | `90` | hard cap |
| `stats.timezone` | `STATS_TIMEZONE` | `UTC` | set it to your SOC's zone |
| `stats.top_n` | `STATS_TOP_N` | `10` | entries per "top N" list |
| `stats.noise_min_alerts` | `STATS_NOISE_MIN_ALERTS` | `10` | floor before a rule can be called noisy |
| `stats.process_field` | `STATS_PROCESS_FIELD` | `process.name` | override if your alerts map it elsewhere |

`stats.process_field` is the field most likely to need changing. If a terms aggregation complains about fielddata, the field is `text` in your mapping and needs a `.keyword` suffix.

## Case titles

| Key | Env | Default | |
| --- | --- | --- | --- |
| `naming.rule_words` | `CASE_TITLE_RULE_WORDS` | unset | truncate the rule name to N words |
| `naming.timezone` | `CASE_TITLE_TIMEZONE` | `stats.timezone` | |

## Security and storage

| Key | Env | Default | |
| --- | --- | --- | --- |
| `security.secret_key` | `ELASTIBOT_SECRET_KEY` | — | 32+ chars. unset means keys stored in plaintext |
| `security.user_store_path` | `USER_STORE_PATH` | `./data/users.json` | |
| `security.state_path` | `STATE_PATH` | `./data/state.json` | |
| `security.incident_store_path` | `INCIDENT_STORE_PATH` | `./data/incidents.json` | |
| `security.auto_provision_slack_ids` | `AUTO_PROVISION_SLACK_IDS` | `[]` | who may use `/start`'s "create one for me" |

## Logging, caching, shutdown

| Key | Env | Default | |
| --- | --- | --- | --- |
| `logging.level` | `LOG_LEVEL` | `info` in prod | `trace`…`silent` |
| `logging.format` | `LOG_FORMAT` | `json` in prod | `pretty` for a terminal |
| `logging.redact` | `LOG_REDACT` | `true` | leave it on |
| `cache.space_name_ttl_ms` | `SPACE_NAME_TTL_MS` | `3600000` | |
| `cache.elastic_client_ttl_ms` | `ELASTIC_CLIENT_TTL_MS` | `900000` | bounds how long a revoked key keeps a client |
| `cache.elastic_max_clients` | `ELASTIC_MAX_CLIENTS` | `250` | |
| `cache.user_ttl_ms` | `USER_CACHE_TTL_MS` | `300000` | |
| `shutdown_timeout_ms` | `SHUTDOWN_TIMEOUT_MS` | `15000` | drain watchers and flush stores before a hard exit |
