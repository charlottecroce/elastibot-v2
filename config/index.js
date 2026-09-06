'use strict';

/*
 * config/index.js - resolves CORE's settings, and folds in whatever the
 * features contribute. Edit `elastibot.yml`, not this file.
 *
 * The `grouping`, `incidents`, `naming`, `stats`, `sigma` and `watchers` blocks
 * are gone from here. They moved to the feature that owns them:
 *
 *   src/features/cases/config.js   grouping, incidents, naming, watchers
 *   src/features/stats/config.js   stats
 *   src/features/sigma/config.js   sigma
 *
 * Every resolved key path is unchanged. config.sigma.pageSize is still
 * config.sigma.pageSize and config.watchers.pollIntervalMs is still
 * config.watchers.pollIntervalMs, so no consumer and no test had to be touched
 * to reorganise the tree.
 *
 * THE LOAD ORDER IS THE TRAP. This module builds its export at require time and
 * tests/setup.js depends on that. The feature half of the tree is reached
 * through src/features/config.js, which requires each feature's config.js
 * DIRECTLY rather than through its descriptor - a descriptor requires services,
 * services require config, and that cycle does not throw. It hands somebody a
 * half-built object and the symptom lands somewhere unrelated.
 *
 * Each core setting below is one `s(yamlKey, ENV_VAR, coercer, default)` call,
 * and that line is the single source of truth for its name, its type and its
 * default. Resolution order is YAML > env var > default; see config/loader.js.
 *
 * elastibot.yml holds everything, secrets included. loader.js checks the mode at
 * boot and complains if it's group- or world-readable. The env var on each line
 * is still honored, for containers that would rather inject a value than mount a
 * file. Nothing reads a .env file to populate them.
 */

require('path');
const { loadConfigFile } = require('./loader');
const { loadFeatureConfig } = require('../src/features/config');

/*
 * Coercers. Each throws on malformed input, naming whichever source the value
 * came from. The loader supplies the default, so these only ever see a value
 * that is actually present.
 *
 * Handed to the features on `s.coercers`. A feature defining its own `bool` is
 * how you end up with "yes" being truthy in one namespace and not another.
 */

class ConfigValueError extends Error { }

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
const list = (v, _label) => {
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

const COERCERS = { bool, int, num, str, list, map };

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

/*
 * Resolved BEFORE the core object below, so that a feature claiming a core
 * namespace throws with both names in the message rather than silently winning
 * or losing depending on merge order.
 */
const featureConfig = loadFeatureConfig(s, COERCERS);

const core = {
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

  /*
   * Which features are on. Resolved by src/features/config.js for every entry in
   * src/features/registry.js, so this map always has one key per registered
   * feature whether or not the operator mentioned it.
   *
   *   features:
   *     sigma:
   *       enabled: false
   *
   * or FEATURE_SIGMA_ENABLED=false
   */
  features: featureConfig.features,

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

  /*
   * Elastic. Core keeps the CONNECTION and the alert INDEX; the endpoints that
   * hang off them belong to features now.
   *
   * alerts_index and default_case_owner stay here rather than moving to cases,
   * because the alert document schema in src/core/elastic/alerts.js has two
   * consumers - cases reads alerts, stats aggregates over them - and one feature
   * owning the index pattern the other one queries would be worse than either.
   */
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
    // via /start's "create one for me" option (src/core/commands/start.js,
    // src/core/elastic/index.js#provisionAnalystApiKey). Loaded from the same
    // file an admin would otherwise paste into POST /_security/api_key by hand,
    // so the manual and automatic paths can never drift apart
    analystRoleDescriptors: requireJson(
      s('elastic.analyst_role_descriptors_path', 'ANALYST_ROLE_DESCRIPTORS_PATH', str, null)
    ),
  },

  // ---------------------------------------------------------------
  // LOGGING
  // Everything logs through src/core/util/logger.js. Secrets are redacted
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

    /*
     * Posted incidents: message coordinates, which alerts are on which case,
     * and the create-case claim.
     *
     * This path is CORE's even though the store itself is now owned by the cases
     * feature, and that is deliberate: it sits with the other two data/ paths so
     * an operator relocating the data directory changes three adjacent lines
     * rather than hunting one of them down inside a feature. The cases feature
     * reads it from here.
     */
    incidentStorePath: s(
      'security.incident_store_path', 'INCIDENT_STORE_PATH', str, './data/incidents.json'
    ),

    /*
     * Slack user IDs permitted to use /start's "create one for me" option,
     * which has Elastibot call POST /_security/api_key itself instead of the
     * analyst copy-pasting a key out of Kibana. Empty (the default) disables
     * the option for everyone.
     *
     * VERIFY THIS LINE against your current file before committing - it is the
     * one setting whose exact yaml key and env var I could not read in full.
     */
    autoProvisionUsers: s(
      'security.auto_provision_users', 'AUTO_PROVISION_SLACK_USERS', list, []
    ),
  },
};

/*
 * Features last. loadFeatureConfig has already refused any namespace core owns,
 * so this assign cannot clobber anything above it.
 */
module.exports = Object.assign(core, featureConfig.namespaces);