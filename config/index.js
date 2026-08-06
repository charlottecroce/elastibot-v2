'use strict';

/*
 * config/index.js - Edit this file to configure your deployment
 * See .env.example for the secrets that must be set in `.env`
 */

require('dotenv').config();

/*
 * Env parsing helpers. Throw on malformed input; an empty value ('') falls
 * back to the default
 */

class EnvError extends Error {}

const fail = (name, value, expected) => {
  throw new EnvError(`${name} must be ${expected}, got ${JSON.stringify(value)}`);
};

const TRUE = ['true', '1', 'yes', 'on'];
const FALSE = ['false', '0', 'no', 'off'];

const bool = (v, dflt, name = 'value') => {
  if (v === undefined || v === '') return dflt;
  const s = String(v).trim().toLowerCase();
  if (TRUE.includes(s)) return true;
  if (FALSE.includes(s)) return false;
  return fail(name, v, `one of ${[...TRUE, ...FALSE].join(', ')}`);
};

const int = (v, dflt, name = 'value') => {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n)) return fail(name, v, 'an integer');
  return n;
};

const num = (v, dflt, name = 'value') => {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) return fail(name, v, 'a number');
  return n;
};

/** Comma-separated list > trimmed, non-empty entries */
const list = (v, dflt) =>
  (v === undefined || v === '' ? dflt : v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

module.exports = {
  // How long shutdown gets to drain watchers and flush stores before a hard exit
  shutdownTimeoutMs: int(process.env.SHUTDOWN_TIMEOUT_MS, 15000, 'SHUTDOWN_TIMEOUT_MS'),

  slack: {
    // --- secrets (.env) ---
    botToken: process.env.SLACK_BOT_TOKEN,          // xoxb-...
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    appToken: process.env.SLACK_APP_TOKEN,          // xapp-...  (Socket Mode only)

    // --- tuning ---
    // Socket Mode needs no public URL - ideal for an internal/same-network deploy
    socketMode: bool(process.env.SLACK_SOCKET_MODE, true, 'SLACK_SOCKET_MODE'),
    port: int(process.env.PORT, 3000, 'PORT'),      // only used when socketMode = false
  },

  elastic: {
    // --- secrets / endpoints (.env) ---
    // API endpoint - every request Elastibot makes goes here, so it must be the
    // instance the API keys authenticate against (usually a direct node, not a proxy)
    kibanaUrl: process.env.KIBANA_URL,
    // Browser endpoint used only for the links posted in Slack. Set it to the proxy
    // analysts actually log in to, so clicking a case link doesn't force a re-login.
    // Falls back to kibanaUrl when unset
    kibanaPublicUrl: process.env.KIBANA_PUBLIC_URL || process.env.KIBANA_URL,
    esUrl: process.env.ELASTICSEARCH_URL,
    // Service key used for non-user work (watchers, space-name lookups)
    serviceApiKey: process.env.ELASTIC_SERVICE_API_KEY,

    // --- tuning ---
    // Internal clusters often use self-signed certs. Set to false to skip TLS verify
    tlsRejectUnauthorized: bool(
      process.env.ELASTIC_TLS_REJECT_UNAUTHORIZED, true, 'ELASTIC_TLS_REJECT_UNAUTHORIZED'
    ),
    requestTimeoutMs: int(process.env.ELASTIC_TIMEOUT_MS, 15000, 'ELASTIC_TIMEOUT_MS'),

    // Keep-alive connection pool size per host
    maxSockets: int(process.env.ELASTIC_MAX_SOCKETS, 50, 'ELASTIC_MAX_SOCKETS'),
    // Ceiling on a single response body
    maxResponseBytes: int(
      process.env.ELASTIC_MAX_RESPONSE_BYTES, 50 * 1024 * 1024, 'ELASTIC_MAX_RESPONSE_BYTES'
    ),

    // Index pattern searched to resolve an alert by ID
    alertsIndex: process.env.ALERTS_INDEX || '.alerts-security.alerts-*',

    // Fallback owner if it can't be derived from the alert's consumer
    defaultOwner: process.env.DEFAULT_CASE_OWNER || 'securitySolution',

    // Retry transient failures (429, 502/503/504, timeouts) on READ requests only.
    // Writes are never retried - creating a case twice is worse than failing once
    retries: int(process.env.ELASTIC_RETRIES, 2, 'ELASTIC_RETRIES'),
    retryBaseDelayMs: int(process.env.ELASTIC_RETRY_BASE_MS, 250, 'ELASTIC_RETRY_BASE_MS'),

    // Role descriptors granted to any API key Elastibot creates automatically
    // via /start's "create one for me" option (src/commands/start.js,
    // src/elastic.js#provisionAnalystApiKey). Loaded from the same file an
    // admin would otherwise paste into POST /_security/api_key by hand, so the
    // manual and automatic paths can never drift apart
    analystRoleDescriptors: require('../api_permissions/elastibot_analyst.json'),
  },

  // ---------------------------------------------------------------
  // LOGGING
  // Everything logs through src/util/logger.js. Secrets are redacted
  // from log records regardless of these settings
  // ---------------------------------------------------------------
  logging: {
    // trace | debug | info | warn | error | fatal | silent
    level: process.env.LOG_LEVEL || (isTest ? 'silent' : isProd ? 'info' : 'debug'),
    // 'json' for log shipping (one object per line), 'pretty' for a terminal
    format: process.env.LOG_FORMAT || (isProd ? 'json' : 'pretty'),
    // Leave on. Only turn it off to debug the redactor itself, never in prod
    redact: bool(process.env.LOG_REDACT, true, 'LOG_REDACT'),
  },

  // ---------------------------------------------------------------
  // CACHING
  // ---------------------------------------------------------------
  cache: {
    // Space display names change about once a year; an hour of staleness after a
    // rename is an acceptable trade for one lookup per space per hour
    spaceNameTtlMs: int(process.env.SPACE_NAME_TTL_MS, 3600000, 'SPACE_NAME_TTL_MS'),
    // Per-analyst Elastic clients are reused rather than rebuilt per command.
    // Expiring them bounds the window in which a revoked key still has a client
    clientTtlMs: int(process.env.ELASTIC_CLIENT_TTL_MS, 900000, 'ELASTIC_CLIENT_TTL_MS'),
    maxClients: int(process.env.ELASTIC_MAX_CLIENTS, 250, 'ELASTIC_MAX_CLIENTS'),
    // Decrypted user records. Bounds how long a rotated key lingers in memory
    userTtlMs: int(process.env.USER_CACHE_TTL_MS, 300000, 'USER_CACHE_TTL_MS'),
  },

  security: {
    // 32+ char secret used to encrypt each analyst's stored Elastic API key at rest
    // (AES-256-GCM, key derived with scrypt and a per-value salt).
    // If unset, keys are stored in plaintext and a warning is logged at startup
    encryptionKey: process.env.ELASTIBOT_SECRET_KEY,

    // Local persistence (gitignored)
    userStorePath: process.env.USER_STORE_PATH || './data/users.json',
    statePath: process.env.STATE_PATH || './data/state.json',
    // Posted incidents: message coordinates, which alerts are on which case,
    // and the create-case claim. Holds no credentials, but losing it means
    // every open incident forgets its case and offers a green button again
    incidentStorePath: process.env.INCIDENT_STORE_PATH || './data/incidents.json',
    // 0 = write through on every change. Raise it to batch cursor writes; the
    // store is flushed on shutdown either way.
    // NOTE this does not apply to the incident store, which is always
    // write-through - see src/context.js for why
    stateDebounceMs: int(process.env.STATE_DEBOUNCE_MS, 0, 'STATE_DEBOUNCE_MS'),

    /*
     * Slack user IDs permitted to use /start's "create one for me" option,
     * which has Elastibot call POST /_security/api_key itself instead of the
     * analyst copy-pasting a key out of Kibana. Empty (the default) disables
     * the option for EVERYONE - it has to be explicitly opted into per Slack
     * user, because using it means pasting a credential capable of creating
     * API keys, which is not something every analyst should be prompted for.
     *
     * This is Slack-side gating layered on top of, not instead of, Elastic's
     * own enforcement: whatever admin credential someone pastes in still has
     * to actually hold manage_api_key / manage_own_api_key, or Elasticsearch
     * rejects the create call regardless of what this list says
     */
    autoProvisionSlackIds: list(process.env.AUTO_PROVISION_SLACK_IDS, ''),
  },

  grouping: {
    // Alerts from the same host (same space) within this window are treated as
    // one incident, collapsed into a single Slack message and, when a case is
    // made, attached together. Default 1 hour
    windowMs: int(process.env.GROUP_WINDOW_MS, 3600000, 'GROUP_WINDOW_MS'),
    // Cap on how many alerts a single grouped case will pull in
    maxAlertsPerCase: int(process.env.GROUP_MAX_ALERTS, 200, 'GROUP_MAX_ALERTS'),

    /*
     * Fold machine-identity alerts into the human incident on the same host.
     *
     * Without this, an analyst session on web-01 that fires alerts under
     * `jsmith` and alerts under `SYSTEM` (because a service ran the command)
     * becomes two messages and two cases, even though it is one incident.
     * Two *human* users on one host still stay separate
     *
     * false = the old spaceId + user + host behaviour
     */
    mergeMachineUsers: bool(
      process.env.GROUP_MERGE_MACHINE_USERS, true, 'GROUP_MERGE_MACHINE_USERS'
    ),

    /*
     * Identities that say nothing about *who* was at the keyboard. Globs,
     * case-insensitive, matched after stripping any domain prefix
     * (NT AUTHORITY\SYSTEM matches SYSTEM). Names ending in `$` are AD computer
     * accounts and always match whether listed or not, as does an absent user
     *
     * TUNE THIS. It is the one setting here that is specific to each environment's naming conventions.
     * The default list is a reasonable starting point
     */
    machineUsers: list(
      process.env.GROUP_MACHINE_USERS,
      'SYSTEM,LOCAL SERVICE,NETWORK SERVICE,LOCAL SYSTEM,ANONYMOUS LOGON,' +
        'root,daemon,nobody,svc_*,svc-*,sa_*,_*'
    ),
  },

  // ---------------------------------------------------------------
  // INCIDENTS
  // How long a posted incident stays live and updatable. This is what lets a
  // burst spread across many poll ticks stay as one Slack message with one case
  // ---------------------------------------------------------------
  incidents: {
    // No new alerts for this long and the record is reaped. The next alert on
    // that host starts a fresh incident with a green Create case button, so
    // pick something like a shift length rather than something short
    idleMs: int(process.env.INCIDENT_IDLE_MS, 8 * 3600000, 'INCIDENT_IDLE_MS'),
    // Hard ceiling regardless of activity. Without it, a host trickling one
    // alert every 7 hours builds one incident that never ends and a case that
    // grows without bound
    maxLifetimeMs: int(
      process.env.INCIDENT_MAX_LIFETIME_MS, 24 * 3600000, 'INCIDENT_MAX_LIFETIME_MS'
    ),
    // How long a create-case claim is honoured before it's treated as abandoned.
    // Long enough to cover the Elastic round trips, short enough that a handler
    // dying mid-click doesn't wedge the incident for the rest of the shift
    claimTtlMs: int(process.env.INCIDENT_CLAIM_TTL_MS, 60000, 'INCIDENT_CLAIM_TTL_MS'),
  },

  naming: {
    // Truncate the rule name in a case title to N words. Unset = use it whole
    truncateRuleWords:
      process.env.CASE_TITLE_RULE_WORDS
        ? int(process.env.CASE_TITLE_RULE_WORDS, null, 'CASE_TITLE_RULE_WORDS')
        : null,
    timeZone: process.env.CASE_TITLE_TIMEZONE || process.env.STATS_TIMEZONE || 'UTC',
  },

  stats: {
    // Lookback used by /stats when the analyst doesn't pass one (e.g. '24h', '7d', '2w')
    defaultWindow: process.env.STATS_DEFAULT_WINDOW || '7d',
    // Hard cap on how far back /stats will look
    maxWindowDays: int(process.env.STATS_MAX_WINDOW_DAYS, 90, 'STATS_MAX_WINDOW_DAYS'),
    // Timezone used to bucket alerts into hours/weekdays. 'UTC' or an IANA name
    timeZone: process.env.STATS_TIMEZONE || 'UTC',
    // How many entries each "top N" list shows
    topN: int(process.env.STATS_TOP_N, 10, 'STATS_TOP_N'),
    // Minimum alerts before a rule can appear in the "noisiest" list
    noiseMinAlerts: int(process.env.STATS_NOISE_MIN_ALERTS, 10, 'STATS_NOISE_MIN_ALERTS'),
    // Field holding the process/program name. Override if your alerts use a
    // different mapping (e.g. 'process.executable'). Validated at boot
    processField: process.env.STATS_PROCESS_FIELD || 'process.name',
  },

  watchers: {
    enabled: bool(process.env.WATCHERS_ENABLED, true, 'WATCHERS_ENABLED'),
    pollIntervalMs: int(process.env.WATCH_POLL_MS, 60000, 'WATCH_POLL_MS'),
    // Randomise each interval by +/- this fraction, so two replicas started by
    // the same deploy don't hit Elastic in lockstep forever
    jitterRatio: num(process.env.WATCH_JITTER_RATIO, 0.1, 'WATCH_JITTER_RATIO'),
    // How many new alerts to pull per poll - keep above a plausible burst size so a
    // spike is grouped in one pass instead of split across polls
    fetchSize: int(process.env.WATCH_FETCH_SIZE, 200, 'WATCH_FETCH_SIZE'),
    // Delay between channel posts within a tick, to stay under Slack rate limits
    postDelayMs: int(process.env.WATCH_POST_DELAY_MS, 300, 'WATCH_POST_DELAY_MS'),

    // ---------------------------------------------------------------
    // CHANNEL ROUTING
    // Map an Elastic space ID to the Slack channel ID that should receive
    // its new alerts and cases. Anything unmatched goes to defaultChannel
    // ---------------------------------------------------------------
    defaultChannel: process.env.DEFAULT_CHANNEL || '',   // e.g. 'C0123456789'
    channelRouting: {
      // 'space-name-1': 'C0123456789',
    },

    alerts: {
      enabled: bool(process.env.WATCH_ALERTS_ENABLED, true, 'WATCH_ALERTS_ENABLED'),
    },
    cases: {
      enabled: bool(process.env.WATCH_CASES_ENABLED, true, 'WATCH_CASES_ENABLED'),
      // Cases are polled per-space via the Kibana Cases API. List the space IDs you want watched here.
      spaces: list(process.env.WATCH_CASE_SPACES, 'default'),
      // Page size for the Cases _find call
      perPage: int(process.env.WATCH_CASES_PER_PAGE, 25, 'WATCH_CASES_PER_PAGE'),
    },
  },
};