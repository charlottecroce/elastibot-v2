'use strict';

const fs = require('fs');
const path = require('path');
const { ConfigError } = require('../src/util/errors');
const { logger } = require('../src/util/logger');

/*
 * Config validation. Collects every problem before throwing, so an operator
 * fixes one round of mistakes instead of one mistake per restart
 */

const log = logger.child({ scope: 'config' });

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
const LOG_FORMATS = ['json', 'pretty'];
const CASE_OWNERS = ['securitySolution', 'observability', 'cases'];
// Shape of an Elastic field name, for the values interpolated into aggregations
const FIELD_NAME_RE = /^[a-zA-Z0-9_.@*-]+$/;

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/*
 * Node resolves `require('./config')` to config.js before config/, so a
 * leftover root config.js shadows this directory entirely
 */
function assertNoStaleConfigFile() {
  const stale = path.join(__dirname, '..', 'config.js');
  if (fs.existsSync(stale)) {
    throw new ConfigError(
      `A stale ${stale} is shadowing config/index.js. Delete it and restart.`
    );
  }
}

/**
 * @param {object} config
 * @param {object} [opts]
 * @param {boolean} [opts.throwOnError] set false to inspect results in a test
 * @returns {{errors: string[], warnings: string[]}}
 */
function validateConfig(config, { throwOnError = true } = {}) {
  if (throwOnError) assertNoStaleConfigFile();

  const errors = [];
  const warnings = [];

  const require_ = (value, name, hint) => {
    if (!value) errors.push(hint ? `${name} is required (${hint})` : `${name} is required`);
  };

  const positiveInt = (value, name) => {
    if (!Number.isInteger(value) || value <= 0) {
      errors.push(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
    }
  };

  const nonNegativeInt = (value, name) => {
    if (!Number.isInteger(value) || value < 0) {
      errors.push(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
    }
  };

  const url = (value, name) => {
    if (value && !isHttpUrl(value)) {
      errors.push(`${name} must be an http(s) URL, got ${JSON.stringify(value)}`);
    }
  };

  const oneOf = (value, allowed, name) => {
    if (value && !allowed.includes(value)) {
      errors.push(`${name} must be one of ${allowed.join(', ')} - got ${JSON.stringify(value)}`);
    }
  };

  const timeZone = (value, name) => {
    if (!value || value === 'UTC') return;
    try {
      Intl.DateTimeFormat(undefined, { timeZone: value });
    } catch {
      errors.push(`${name} is not a recognised IANA timezone: ${JSON.stringify(value)}`);
    }
  };

  // --- Process ---
  positiveInt(config.shutdownTimeoutMs, 'SHUTDOWN_TIMEOUT_MS');

  // --- Slack ---
  require_(config.slack.botToken, 'SLACK_BOT_TOKEN');
  require_(config.slack.signingSecret, 'SLACK_SIGNING_SECRET');
  if (config.slack.socketMode) {
    require_(config.slack.appToken, 'SLACK_APP_TOKEN', 'Socket Mode');
  } else {
    positiveInt(config.slack.port, 'PORT');
  }
  if (config.slack.botToken && !/^xoxb-/.test(config.slack.botToken)) {
    warnings.push('SLACK_BOT_TOKEN does not start with xoxb- - is that the bot token?');
  }
  if (config.slack.appToken && !/^xapp-/.test(config.slack.appToken)) {
    warnings.push('SLACK_APP_TOKEN does not start with xapp- - is that the app-level token?');
  }

  // --- Elastic ---
  require_(config.elastic.kibanaUrl, 'KIBANA_URL');
  require_(config.elastic.esUrl, 'ELASTICSEARCH_URL');
  url(config.elastic.kibanaUrl, 'KIBANA_URL');
  url(config.elastic.kibanaPublicUrl, 'KIBANA_PUBLIC_URL');
  url(config.elastic.esUrl, 'ELASTICSEARCH_URL');
  positiveInt(config.elastic.requestTimeoutMs, 'ELASTIC_TIMEOUT_MS');
  positiveInt(config.elastic.maxSockets, 'ELASTIC_MAX_SOCKETS');
  positiveInt(config.elastic.maxResponseBytes, 'ELASTIC_MAX_RESPONSE_BYTES');
  nonNegativeInt(config.elastic.retries, 'ELASTIC_RETRIES');
  positiveInt(config.elastic.retryBaseDelayMs, 'ELASTIC_RETRY_BASE_MS');
  oneOf(config.elastic.defaultOwner, CASE_OWNERS, 'DEFAULT_CASE_OWNER');
  require_(config.elastic.alertsIndex, 'ALERTS_INDEX');

  if (config.elastic.tlsRejectUnauthorized === false) {
    warnings.push(
      'ELASTIC_TLS_REJECT_UNAUTHORIZED=false - TLS certificates are NOT verified. ' +
        'Acceptable for an internal cluster with a self-signed cert, not otherwise'
    );
  }

  // --- Security ---
  if (!config.security.encryptionKey) {
    warnings.push(
      'ELASTIBOT_SECRET_KEY is not set - analyst API keys will be stored UNENCRYPTED. ' +
        'Generate one with: openssl rand -hex 16'
    );
  } else if (config.security.encryptionKey.length < 32) {
    warnings.push(
      `ELASTIBOT_SECRET_KEY is only ${config.security.encryptionKey.length} chars - use 32 or more`
    );
  }
  nonNegativeInt(config.security.stateDebounceMs, 'STATE_DEBOUNCE_MS');

  // --- Caching ---
  positiveInt(config.cache.spaceNameTtlMs, 'SPACE_NAME_TTL_MS');
  positiveInt(config.cache.clientTtlMs, 'ELASTIC_CLIENT_TTL_MS');
  positiveInt(config.cache.maxClients, 'ELASTIC_MAX_CLIENTS');
  nonNegativeInt(config.cache.userTtlMs, 'USER_CACHE_TTL_MS');

  // --- Grouping ---
  positiveInt(config.grouping.windowMs, 'GROUP_WINDOW_MS');
  positiveInt(config.grouping.maxAlertsPerCase, 'GROUP_MAX_ALERTS');

  // --- Logging ---
  oneOf(config.logging.level, LOG_LEVELS, 'LOG_LEVEL');
  oneOf(config.logging.format, LOG_FORMATS, 'LOG_FORMAT');

  // --- Watchers ---
  if (config.watchers.enabled) {
    positiveInt(config.watchers.pollIntervalMs, 'WATCH_POLL_MS');
    positiveInt(config.watchers.fetchSize, 'WATCH_FETCH_SIZE');
    nonNegativeInt(config.watchers.postDelayMs, 'WATCH_POST_DELAY_MS');
    positiveInt(config.watchers.cases.perPage, 'WATCH_CASES_PER_PAGE');

    if (!(config.watchers.jitterRatio >= 0 && config.watchers.jitterRatio < 1)) {
      errors.push(
        'WATCH_JITTER_RATIO must be between 0 and 1 (exclusive), got ' +
          JSON.stringify(config.watchers.jitterRatio)
      );
    }

    // The runner honours whatever it is given, so the sanity floor belongs here
    if (config.watchers.pollIntervalMs < 5000) {
      warnings.push(
        `WATCH_POLL_MS is ${config.watchers.pollIntervalMs} - polling Elastic more than once ` +
          'every 5s adds load for no benefit; alerts are not that fresh'
      );
    }

    // Worst-case call duration above the poll interval means the runner's
    // overlap guard starts skipping ticks
    const worstCallMs = (config.elastic.retries + 1) * config.elastic.requestTimeoutMs;
    if (worstCallMs >= config.watchers.pollIntervalMs) {
      warnings.push(
        `a single Elastic call can take up to ${worstCallMs}ms ` +
          `(ELASTIC_RETRIES ${config.elastic.retries} x ELASTIC_TIMEOUT_MS ` +
          `${config.elastic.requestTimeoutMs}), which is at or above WATCH_POLL_MS ` +
          `${config.watchers.pollIntervalMs} - ticks will be skipped under load`
      );
    }

    if (!config.elastic.serviceApiKey) {
      warnings.push(
        'WATCHERS_ENABLED is true but ELASTIC_SERVICE_API_KEY is not set - ' +
          'watchers will not run. Set the key, or WATCHERS_ENABLED=false'
      );
    }

    const routed = Object.keys(config.watchers.channelRouting || {});
    if (!config.watchers.defaultChannel && routed.length === 0) {
      warnings.push(
        'no DEFAULT_CHANNEL and no channelRouting entries - watchers will post nothing'
      );
    }

    // The whole point of postDelayMs is Slack's ~1 msg/sec channel limit. A
    // burst of 50 incidents at 300ms takes 15s, which is fine; at 0 it is a
    // guaranteed 429
    if (config.watchers.postDelayMs < 100) {
      warnings.push(
        `WATCH_POST_DELAY_MS is ${config.watchers.postDelayMs} - Slack will rate limit a burst. ` +
          'Keep it at 300 or above'
      );
    }

    if (config.watchers.cases.enabled && config.watchers.cases.spaces.length === 0) {
      warnings.push('case watcher is enabled but WATCH_CASE_SPACES is empty');
    }
  }

  // --- Naming ---
  timeZone(config.naming?.timeZone, 'CASE_TITLE_TIMEZONE');
  if (config.naming?.truncateRuleWords !== null && config.naming?.truncateRuleWords !== undefined) {
    positiveInt(config.naming.truncateRuleWords, 'CASE_TITLE_RULE_WORDS');
  }

  // --- Stats ---
  positiveInt(config.stats.maxWindowDays, 'STATS_MAX_WINDOW_DAYS');
  positiveInt(config.stats.topN, 'STATS_TOP_N');
  positiveInt(config.stats.noiseMinAlerts, 'STATS_NOISE_MIN_ALERTS');
  timeZone(config.stats.timeZone, 'STATS_TIMEZONE');
  if (!FIELD_NAME_RE.test(String(config.stats.processField || ''))) {
    errors.push(
      `STATS_PROCESS_FIELD is not a valid field name: ${JSON.stringify(config.stats.processField)}`
    );
  }
  if (!/^(\d+)(m|h|d|w)$/i.test(String(config.stats.defaultWindow || ''))) {
    errors.push(
      'STATS_DEFAULT_WINDOW must look like 24h, 7d or 2w - got ' +
        JSON.stringify(config.stats.defaultWindow)
    );
  }

  for (const w of warnings) log.warn(w);

  if (errors.length && throwOnError) {
    log.fatal('configuration is invalid', { problems: errors.length });
    throw new ConfigError(
      `Configuration is invalid:\n  - ${errors.join('\n  - ')}\n\n` +
        'Copy .env.example to .env and fill it in.'
    );
  }

  if (!errors.length) log.debug('configuration validated', { warnings: warnings.length });

  return { errors, warnings };
}

module.exports = { validateConfig };