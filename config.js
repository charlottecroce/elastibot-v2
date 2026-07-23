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
    kibanaUrl: process.env.KIBANA_URL,
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

  security: {
    // 32+ char secret used to encrypt each analyst's stored Elastic API key at rest (AES-256-GCM)
    // If unset, keys are stored in plaintext and a warning is logged at startup
    encryptionKey: process.env.ELASTIBOT_SECRET_KEY,

    // Local persistence (gitignored)
    userStorePath: process.env.USER_STORE_PATH || './data/users.json',
    statePath: process.env.STATE_PATH || './data/state.json',
  },

  naming: {
    truncateRuleWords: null,
  },

  watchers: {
    enabled: bool(process.env.WATCHERS_ENABLED, true),
    pollIntervalMs: int(process.env.WATCH_POLL_MS, 60000),

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