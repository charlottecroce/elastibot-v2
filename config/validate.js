'use strict';

const { ConfigError } = require('../src/util/errors');
const { logger } = require('../src/util/logger');

/*
 * Config validation.
 *
 */

const log = logger.child({ scope: 'config' });

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
const LOG_FORMATS = ['json', 'pretty'];

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * @param {object} config
 * @param {object} [opts]
 * @param {boolean} [opts.throwOnError] set false to inspect results in a test
 * @returns {{errors: string[], warnings: string[]}}
 */
function validateConfig(config, { throwOnError = true } = {}) {
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

  // --- Logging ---
  oneOf(config.logging.level, LOG_LEVELS, 'LOG_LEVEL');
  oneOf(config.logging.format, LOG_FORMATS, 'LOG_FORMAT');

  // --- Watchers ---
  if (config.watchers.enabled) {
    positiveInt(config.watchers.pollIntervalMs, 'WATCH_POLL_MS');
    positiveInt(config.watchers.fetchSize, 'WATCH_FETCH_SIZE');

    if (config.watchers.jitterRatio < 0 || config.watchers.jitterRatio >= 1) {
      errors.push('WATCH_JITTER_RATIO must be between 0 and 1 (exclusive)');
    }

    // The runner honours whatever it is given, so the sanity floor belongs here
    if (config.watchers.pollIntervalMs < 5000) {
      warnings.push(
        `WATCH_POLL_MS is ${config.watchers.pollIntervalMs} - polling Elastic more than once ` +
          'every 5s adds load for no benefit; alerts are not that fresh'
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
  if (config.naming?.timeZone && config.naming.timeZone !== 'UTC') {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: config.naming.timeZone });
    } catch {
      errors.push(
        'CASE_TITLE_TIMEZONE is not a recognised IANA timezone: ' +
          JSON.stringify(config.naming.timeZone)
      );
    }
  }

  // --- Stats ---
  positiveInt(config.stats.maxWindowDays, 'STATS_MAX_WINDOW_DAYS');
  positiveInt(config.stats.topN, 'STATS_TOP_N');
  if (config.stats.timeZone && config.stats.timeZone !== 'UTC') {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: config.stats.timeZone });
    } catch {
      errors.push(
        `STATS_TIMEZONE is not a recognised IANA timezone: ${JSON.stringify(config.stats.timeZone)}`
      );
    }
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