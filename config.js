'use strict';

/*
 * config.js - Edit this file to configure your deployment
 * See .env.example for the secrets that must be set in `.env`
 *
 */

require('dotenv').config();

/** helpers so env vars parse predictably */
const bool = (v, dflt) => (v === undefined ? dflt : String(v).toLowerCase() === 'true');
const int = (v, dflt) => (v === undefined ? dflt : parseInt(v, 10));

const isProd = process.env.NODE_ENV === 'production';

module.exports = {
  slack: {
    // --- secrets (.env) ---
    botToken: process.env.SLACK_BOT_TOKEN,          // xoxb-...
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    appToken: process.env.SLACK_APP_TOKEN,          // xapp-...  (Socket Mode only)

    // --- tuning ---
    // Socket Mode needs no public URL - ideal for an internal/same-network deploy
    socketMode: bool(process.env.SLACK_SOCKET_MODE, true),
    port: int(process.env.PORT, 3000),              // only used when socketMode = false
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
    tlsRejectUnauthorized: bool(process.env.ELASTIC_TLS_REJECT_UNAUTHORIZED, true),
    requestTimeoutMs: int(process.env.ELASTIC_TIMEOUT_MS, 15000),

    // Index pattern searched to resolve an alert by ID
    alertsIndex: process.env.ALERTS_INDEX || '.alerts-security.alerts-*',

    // Fallback owner if it can't be derived from the alert's consumer
    defaultOwner: process.env.DEFAULT_CASE_OWNER || 'securitySolution',
  },

  // ---------------------------------------------------------------
  // LOGGING
  // Everything logs through src/util/logger.js. Secrets are redacted
  // from log records regardless of these settings
  // ---------------------------------------------------------------
  logging: {
    // trace | debug | info | warn | error | fatal | silent
    // Tests default to silent unless LOG_LEVEL is set explicitly
    level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
    // 'json' for log shipping (one object per line), 'pretty' for a terminal
    format: process.env.LOG_FORMAT || (isProd ? 'json' : 'pretty'),
    // Leave on. Only turn it off to debug the redactor itself, never in prod
    redact: bool(process.env.LOG_REDACT, true),
  },

  security: {
    // 32+ char secret used to encrypt each analyst's stored Elastic API key at rest (AES-256-GCM)
    // If unset, keys are stored in plaintext and a warning is logged at startup
    encryptionKey: process.env.ELASTIBOT_SECRET_KEY,

    // Local persistence (gitignored)
    userStorePath: process.env.USER_STORE_PATH || './data/users.json',
    statePath: process.env.STATE_PATH || './data/state.json',
  },

  grouping: {
    // Alerts from the same user + host (same space) within this window are treated
    // as one incident, collapsed into a single Slack message and, when a case is
    // made, attached together. Default 1 hour
    windowMs: int(process.env.GROUP_WINDOW_MS, 3600000),
    // Cap on how many alerts a single grouped case will pull in
    maxAlertsPerCase: int(process.env.GROUP_MAX_ALERTS, 200),
  },

  naming: {
    truncateRuleWords: null,
  },

  stats: {
    // Lookback used by /stats when the analyst doesn't pass one (e.g. '24h', '7d', '2w')
    defaultWindow: process.env.STATS_DEFAULT_WINDOW || '7d',
    // Hard cap on how far back /stats will look. Aggregations are cheap but not free
    maxWindowDays: int(process.env.STATS_MAX_WINDOW_DAYS, 90),
    // Timezone used to bucket alerts into hours/weekdays. 'UTC' or an IANA name like 'America/New_York'
    timeZone: process.env.STATS_TIMEZONE || 'UTC',
    // How many entries each "top N" list shows
    topN: int(process.env.STATS_TOP_N, 10),
    // A rule needs at least this many alerts in the window before /stats will
    // call it noisy
    noiseMinAlerts: int(process.env.STATS_NOISE_MIN_ALERTS, 10),
    // Field holding the process/program name. Override if your alerts use a
    // different mapping (e.g. 'process.executable')
    processField: process.env.STATS_PROCESS_FIELD || 'process.name',
  },

  watchers: {
    enabled: bool(process.env.WATCHERS_ENABLED, true),
    pollIntervalMs: int(process.env.WATCH_POLL_MS, 60000),
    // How many new alerts to pull per poll - keep above a plausible burst size so a
    // spike is grouped in one pass instead of split across polls
    fetchSize: int(process.env.WATCH_FETCH_SIZE, 200),
    // Delay between channel posts within a tick, to stay under Slack rate limits
    postDelayMs: int(process.env.WATCH_POST_DELAY_MS, 300),
    // How long an incident (space+user+host) stays "open" for in-place message
    // updates before a later alert starts a fresh message. Default 10 minutes
    incidentTtlMs: int(process.env.WATCH_INCIDENT_TTL_MS, 600000),

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
      enabled: true,
    },
    cases: {
      enabled: true,
      // Cases are polled per-space via the Kibana Cases API. List the space IDs you want watched here.
      spaces: (process.env.WATCH_CASE_SPACES || 'default')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
  },
};
