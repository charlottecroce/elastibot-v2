'use strict';

/*
 * config/index.js - resolves every setting. Edit `elastibot.yml`, not this file.
 *
 * Each setting below is one `s(yamlKey, ENV_VAR, coercer, default)` call, and
 * that line is the single source of truth for its name, its type and its
 * default. Resolution order is YAML > env var > default; see config/loader.js.
 *
 * elastibot.yml holds everything, secrets included. loader.js checks the
 * mode at boot and complains if it's group- or world-readable.
 *
 * The env var on each line is still honored, for containers and orchestrators
 * that would rather inject a value than mount a file. Nothing reads a .env
 * file to populate them, though; they have to be genuinely exported.
 */

const { loadConfigFile } = require('./loader');

/*
 * Coercers. Each throws on malformed input, naming whichever source the value
 * came from. The loader supplies the default, so these only ever see a value
 * that is actually present
 */

class ConfigValueError extends Error {}

const fail = (label, value, expected) => {
  throw new ConfigValueError(`${label} must be ${expected}, got ${JSON.stringify(value)}`);
};

const TRUE = ['true', '1', 'yes', 'on'];
const FALSE = ['false', '0', 'no', 'off'];

const bool = (v, label) => {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (TRUE.includes(s)) return true;
  if (FALSE.includes(s)) return false;
  return fail(label, v, `one of ${[...TRUE, ...FALSE].join(', ')}`);
};

const int = (v, label) => {
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isInteger(n)) return fail(label, v, 'an integer');
  return n;
};

const num = (v, label) => {
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return fail(label, v, 'a number');
  return n;
};

const str = (v, label) => {
  if (v === null || typeof v === 'object') return fail(label, v, 'a string');
  return String(v);
};

/** A YAML sequence, or (from an env var) a comma-separated string */
const list = (v, label) => {
  const items = Array.isArray(v) ? v : String(v).split(',');
  return items.map((s) => String(s).trim()).filter(Boolean);
};

/** A YAML mapping of string > string, e.g. channel_routing */
const map = (v, label) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return fail(label, v, 'a mapping of key: value pairs');
  }
  return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, String(val)]));
};

/*
 * Role descriptors, from the same JSON an admin would otherwise paste into
 * POST /_security/api_key by hand. An operator-supplied path is relative to the
 * working directory (which is what they'd expect from a path in elastibot.yml);
 * the built-in default is relative to this file
 */
function requireJson(override) {
  if (!override) return require('../api_permissions/elastibot_analyst.json');
  return require(require('path').resolve(process.cwd(), override));
}

const file = loadConfigFile();
const s = file.get;

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

module.exports = {
  /*
   * Where the settings came from. app.js logs this at boot and warns about:
   *   - `permissions`, when the file holding every credential is readable by
   *     someone other than its owner
   *   - `shadowed`, a setting present in BOTH elastibot.yml and the
   *     environment, where the YAML won and the env var did nothing
   */
  source: {
    file: file.file,
    permissions: file.permissions,
    shadowed: file.shadowed,
    unresolved: file.unresolved,
  },

  // How long shutdown gets to drain watchers and flush stores before a hard exit
  shutdownTimeoutMs: s('shutdown_timeout_ms', 'SHUTDOWN_TIMEOUT_MS', int, 15000),

  slack: {
    // --- secrets ---
    botToken: s('slack.bot_token', 'SLACK_BOT_TOKEN', str, undefined), // xoxb-...
    signingSecret: s('slack.signing_secret', 'SLACK_SIGNING_SECRET', str, undefined),
    appToken: s('slack.app_token', 'SLACK_APP_TOKEN', str, undefined), // xapp-... (Socket Mode)

    // --- tuning ---
    // Socket Mode needs no public URL - ideal for an internal/same-network deploy
    socketMode: s('slack.socket_mode', 'SLACK_SOCKET_MODE', bool, true),
    port: s('slack.port', 'PORT', int, 3000), // only used when socketMode = false
  },

  elastic: {
    // --- secrets / endpoints ---
    // API endpoint - every request Elastibot makes goes here, so it must be the
    // instance the API keys authenticate against (usually a direct node, not a proxy)
    kibanaUrl: s('elastic.kibana_url', 'KIBANA_URL', str, undefined),
    // Browser endpoint used only for the links posted in Slack. Set it to the proxy
    // analysts actually log in to, so clicking a case link doesn't force a re-login.
    // Falls back to kibanaUrl when unset
    kibanaPublicUrl:
      s('elastic.kibana_public_url', 'KIBANA_PUBLIC_URL', str, undefined) ||
      s('elastic.kibana_url', 'KIBANA_URL', str, undefined),
    esUrl: s('elastic.elasticsearch_url', 'ELASTICSEARCH_URL', str, undefined),
    // Service key used for non-user work (watchers, space-name lookups)
    serviceApiKey: s('elastic.service_api_key', 'ELASTIC_SERVICE_API_KEY', str, undefined),

    // --- tuning ---
    // Internal clusters often use self-signed certs. Set to false to skip TLS verify
    tlsRejectUnauthorized: s(
      'elastic.tls_reject_unauthorized', 'ELASTIC_TLS_REJECT_UNAUTHORIZED', bool, true
    ),
    requestTimeoutMs: s('elastic.timeout_ms', 'ELASTIC_TIMEOUT_MS', int, 15000),

    // Keep-alive connection pool size per host
    maxSockets: s('elastic.max_sockets', 'ELASTIC_MAX_SOCKETS', int, 50),
    // Ceiling on a single response body
    maxResponseBytes: s(
      'elastic.max_response_bytes', 'ELASTIC_MAX_RESPONSE_BYTES', int, 50 * 1024 * 1024
    ),

    // Index pattern searched to resolve an alert by ID
    alertsIndex: s('elastic.alerts_index', 'ALERTS_INDEX', str, '.alerts-security.alerts-*'),

    // Fallback owner if it can't be derived from the alert's consumer
    defaultOwner: s('elastic.default_case_owner', 'DEFAULT_CASE_OWNER', str, 'securitySolution'),

    // Retry transient failures (429, 502/503/504, timeouts) on READ requests only.
    // Writes are never retried - creating a case twice is worse than failing once
    retries: s('elastic.retries', 'ELASTIC_RETRIES', int, 2),
    retryBaseDelayMs: s('elastic.retry_base_ms', 'ELASTIC_RETRY_BASE_MS', int, 250),

    // Role descriptors granted to any API key Elastibot creates automatically
    // via /start's "create one for me" option (src/commands/start.js,
    // src/elastic.js#provisionAnalystApiKey). Loaded from the same file an
    // admin would otherwise paste into POST /_security/api_key by hand, so the
    // manual and automatic paths can never drift apart
    analystRoleDescriptors: requireJson(
      s('elastic.analyst_role_descriptors_path', 'ANALYST_ROLE_DESCRIPTORS_PATH', str, null)
    ),
  },

  // ---------------------------------------------------------------
  // LOGGING
  // Everything logs through src/util/logger.js. Secrets are redacted
  // from log records regardless of these settings
  // ---------------------------------------------------------------
  logging: {
    // trace | debug | info | warn | error | fatal | silent
    level: s('logging.level', 'LOG_LEVEL', str, isTest ? 'silent' : isProd ? 'info' : 'debug'),
    // 'json' for log shipping (one object per line), 'pretty' for a terminal
    format: s('logging.format', 'LOG_FORMAT', str, isProd ? 'json' : 'pretty'),
    // Leave on. Only turn it off to debug the redactor itself, never in prod
    redact: s('logging.redact', 'LOG_REDACT', bool, true),
  },

  // ---------------------------------------------------------------
  // CACHING
  // ---------------------------------------------------------------
  cache: {
    // Space display names change about once a year; an hour of staleness after a
    // rename is an acceptable trade for one lookup per space per hour
    spaceNameTtlMs: s('cache.space_name_ttl_ms', 'SPACE_NAME_TTL_MS', int, 3600000),
    // Per-analyst Elastic clients are reused rather than rebuilt per command.
    // Expiring them bounds the window in which a revoked key still has a client
    clientTtlMs: s('cache.elastic_client_ttl_ms', 'ELASTIC_CLIENT_TTL_MS', int, 900000),
    maxClients: s('cache.elastic_max_clients', 'ELASTIC_MAX_CLIENTS', int, 250),
    // Decrypted user records. Bounds how long a rotated key lingers in memory
    userTtlMs: s('cache.user_ttl_ms', 'USER_CACHE_TTL_MS', int, 300000),
  },

  security: {
    // 32+ char secret used to encrypt each analyst's stored Elastic API key at rest
    // (AES-256-GCM, key derived with scrypt and a per-value salt).
    // If unset, keys are stored in plaintext and a warning is logged at startup
    encryptionKey: s('security.secret_key', 'ELASTIBOT_SECRET_KEY', str, undefined),

    /*
     * Local persistence (gitignored). Every store here is write-through: the
     * alert cursor, the user keys and the incident records are all read back
     * after a restart, and anything that copies data/ out from under a live
     * process captures whatever was last written, not whatever is in memory
     */
    userStorePath: s('security.user_store_path', 'USER_STORE_PATH', str, './data/users.json'),
    statePath: s('security.state_path', 'STATE_PATH', str, './data/state.json'),
    // Posted incidents: message coordinates, which alerts are on which case,
    // and the create-case claim. Holds no credentials, but losing it means
    // every open incident forgets its case and offers a green button again
    incidentStorePath: s(
      'security.incident_store_path', 'INCIDENT_STORE_PATH', str, './data/incidents.json'
    ),

    /*
     * Slack user IDs permitted to use /start's "create one for me" option,
     * which has Elastibot call POST /_security/api_key itself instead of the
     * analyst copy-pasting a key out of Kibana. Empty (the default) disables
     * the option for everyone.
     *
     * This is Slack-side gating only. Elasticsearch separately
     * enforces that whatever admin credential someone pastes into that option
     * actually holds manage_api_key / manage_own_api_key
     */
    autoProvisionSlackIds: s(
      'security.auto_provision_slack_ids', 'AUTO_PROVISION_SLACK_IDS', list, []
    ),
  },

  // ---------------------------------------------------------------
  // GROUPING
  // A burst of alerts from one user on one host is one incident
  // ---------------------------------------------------------------
  grouping: {
    // Window measured from the FIRST alert in a cluster, not the previous one
    windowMs: s('grouping.window_ms', 'GROUP_WINDOW_MS', int, 3600000),
    // Pass 2: fold machine-identity clusters into the human cluster they overlap
    mergeMachineUsers: s('grouping.merge_machine_users', 'GROUP_MERGE_MACHINE_USERS', bool, true),
    // Ceiling on how many alerts get folded into one case
    maxAlertsPerCase: s('grouping.max_alerts', 'GROUP_MAX_ALERTS', int, 200),
    /*
     * Identities treated as machine rather than human. Globs allowed.
     * It is the one setting here that is specific to each environment's naming
     * conventions. The default list is a reasonable starting point
     */
    machineUsers: s('grouping.machine_users', 'GROUP_MACHINE_USERS', list, [
      'SYSTEM', 'LOCAL SERVICE', 'NETWORK SERVICE', 'LOCAL SYSTEM', 'ANONYMOUS LOGON',
      'root', 'daemon', 'nobody', 'svc_*', 'svc-*', 'sa_*', '_*',
    ]),
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
    idleMs: s('incidents.idle_ms', 'INCIDENT_IDLE_MS', int, 8 * 3600000),
    // Hard ceiling regardless of activity
    maxLifetimeMs: s('incidents.max_lifetime_ms', 'INCIDENT_MAX_LIFETIME_MS', int, 24 * 3600000),
    // How long a create-case claim is honoured before it's treated as abandoned.
    // Long enough to cover the Elastic round trips, short enough that a handler
    // dying mid-click doesn't wedge the incident for the rest of the shift
    claimTtlMs: s('incidents.claim_ttl_ms', 'INCIDENT_CLAIM_TTL_MS', int, 60000),
  },

  naming: {
    // Truncate the rule name in a case title to N words. Unset = use it whole
    truncateRuleWords: s('naming.rule_words', 'CASE_TITLE_RULE_WORDS', int, null),
    timeZone:
      s('naming.timezone', 'CASE_TITLE_TIMEZONE', str, undefined) ||
      s('stats.timezone', 'STATS_TIMEZONE', str, 'UTC'),
  },

  stats: {
    // Lookback used by /stats when the analyst doesn't pass one (e.g. '24h', '7d', '2w')
    defaultWindow: s('stats.default_window', 'STATS_DEFAULT_WINDOW', str, '7d'),
    // Hard cap on how far back /stats will look
    maxWindowDays: s('stats.max_window_days', 'STATS_MAX_WINDOW_DAYS', int, 90),
    // Timezone used to bucket alerts into hours/weekdays. 'UTC' or an IANA name
    timeZone: s('stats.timezone', 'STATS_TIMEZONE', str, 'UTC'),
    // How many entries each "top N" list shows
    topN: s('stats.top_n', 'STATS_TOP_N', int, 10),
    // Minimum alerts before a rule can appear in the "noisiest" list
    noiseMinAlerts: s('stats.noise_min_alerts', 'STATS_NOISE_MIN_ALERTS', int, 10),
    // Field holding the process/program name. Override if your alerts use a
    // different mapping (e.g. 'process.executable'). Validated at boot
    processField: s('stats.process_field', 'STATS_PROCESS_FIELD', str, 'process.name'),
  },

  watchers: {
    enabled: s('watchers.enabled', 'WATCHERS_ENABLED', bool, true),
    pollIntervalMs: s('watchers.poll_ms', 'WATCH_POLL_MS', int, 60000),
    // Randomise each interval by +/- this fraction, so two replicas started by
    // the same deploy don't hit Elastic in lockstep forever
    jitterRatio: s('watchers.jitter_ratio', 'WATCH_JITTER_RATIO', num, 0.1),
    // How many new alerts to pull per poll - keep above a plausible burst size so a
    // spike is grouped in one pass instead of split across polls
    fetchSize: s('watchers.fetch_size', 'WATCH_FETCH_SIZE', int, 200),
    // Delay between channel posts within a tick, to stay under Slack rate limits
    postDelayMs: s('watchers.post_delay_ms', 'WATCH_POST_DELAY_MS', int, 300),

    // ---------------------------------------------------------------
    // CHANNEL ROUTING
    // Map an Elastic space ID to the Slack channel ID that should receive
    // its new alerts and cases. Anything unmatched goes to default_channel.
    // ---------------------------------------------------------------
    defaultChannel: s('watchers.default_channel', 'DEFAULT_CHANNEL', str, ''),
    channelRouting: s('watchers.channel_routing', null, map, {}),

    alerts: {
      enabled: s('watchers.alerts.enabled', 'WATCH_ALERTS_ENABLED', bool, true),
    },
    cases: {
      enabled: s('watchers.cases.enabled', 'WATCH_CASES_ENABLED', bool, true),
      // Cases are polled per-space via the Kibana Cases API. List the space IDs
      // you want watched here
      spaces: s('watchers.cases.spaces', 'WATCH_CASE_SPACES', list, ['default']),
      // Page size for the Cases _find call
      perPage: s('watchers.cases.per_page', 'WATCH_CASES_PER_PAGE', int, 25),
    },
  },
};