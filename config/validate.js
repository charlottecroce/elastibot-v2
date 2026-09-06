'use strict';

const { ConfigError } = require('../src/core/util/errors');
const { isAbsoluteHttpUrl } = require('../src/core/util/url');
const { logger } = require('../src/core/util/logger');
const { validateFeatureConfig } = require('../src/features/config');

/*
 * Config validation. Collects every problem before throwing, so an operator
 * fixes one round of mistakes instead of one mistake per restart.
 *
 * The --- Naming ---, --- Stats ---, --- Sigma --- and --- Watchers --- sections
 * are gone from this file. They live in each feature's config.js next to the
 * defaults they check, which is the point: a setting and its validation should
 * not be able to drift across a folder boundary, and deleting a feature should
 * delete its validation with it.
 *
 * The collect-everything behaviour survives the split intact. Feature validators
 * are handed the SAME errors and warnings arrays, so a bad sigma page size and a
 * missing Slack token still come out of one boot together. They also run for
 * DISABLED features: a setting that is wrong in the file is worth reporting
 * before somebody switches the feature on and hits it at three in the morning.
 */

const log = logger.child({ scope: 'config' });

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
const LOG_FORMATS = ['json', 'pretty'];
const CASE_OWNERS = ['securitySolution', 'observability', 'cases'];

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

  const nonNegativeInt = (value, name) => {
    if (!Number.isInteger(value) || value < 0) {
      errors.push(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
    }
  };

  const url = (value, name) => {
    if (value && !isAbsoluteHttpUrl(value)) {
      errors.push(`${name} must be an http(s) URL, got ${JSON.stringify(value)}`);
    }
  };

  const oneOf = (value, allowed, name) => {
    if (value && !allowed.includes(value)) {
      errors.push(`${name} must be one of ${allowed.join(', ')} - got ${JSON.stringify(value)}`);
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
      'ELASTIC_TLS_REJECT_UNAUTHORIZED=false - TLS certificates are not being verified. ' +
      'Fine for an internal cluster with a self-signed cert, not fine otherwise'
    );
  }

  // --- Logging ---
  oneOf(config.logging.level, LOG_LEVELS, 'LOG_LEVEL');
  oneOf(config.logging.format, LOG_FORMATS, 'LOG_FORMAT');
  if (config.logging.redact === false) {
    warnings.push('LOG_REDACT=false - secrets will appear in the logs. Only ever do this locally');
  }

  // --- Security ---
  if (!config.security.encryptionKey) {
    warnings.push(
      'ELASTIBOT_SECRET_KEY is not set - analyst API keys are stored on disk in PLAINTEXT. ' +
      'Set a 32+ character secret and have every analyst re-run /start'
    );
  } else if (String(config.security.encryptionKey).length < 32) {
    warnings.push(
      `ELASTIBOT_SECRET_KEY is only ${config.security.encryptionKey.length} characters - ` +
      'use at least 32'
    );
  }
  require_(config.security.userStorePath, 'USER_STORE_PATH');
  require_(config.security.statePath, 'STATE_PATH');
  require_(config.security.incidentStorePath, 'INCIDENT_STORE_PATH');

  // --- Cache ---
  positiveInt(config.cache.spaceNameTtlMs, 'SPACE_NAME_TTL_MS');
  positiveInt(config.cache.clientTtlMs, 'ELASTIC_CLIENT_TTL_MS');
  positiveInt(config.cache.maxClients, 'ELASTIC_MAX_CLIENTS');
  nonNegativeInt(config.cache.userTtlMs, 'USER_CACHE_TTL_MS');

  // --- Config file hygiene ---
  if (config.source?.permissions?.tooOpen) {
    warnings.push(
      `${config.source.file} is readable by more than its owner - it holds every credential ` +
      'this bot has. chmod 600 it'
    );
  }
  for (const { key, env } of config.source?.shadowed || []) {
    warnings.push(
      `${key} is set in both elastibot.yml and ${env} - the file won and ${env} did nothing`
    );
  }
  for (const { key, env } of config.source?.unresolved || []) {
    warnings.push(`${key} references \${${env}}, which is not set - treated as unconfigured`);
  }

  /*
   * --- Features ---
   *
   * Last, so that a feature complaining about something core already flagged
   * reads as a consequence rather than as the cause. A validator that throws is
   * reported as an error rather than being allowed to take the process down: a
   * broken validator should not be a harder failure than the thing it validates.
   */
  validateFeatureConfig(config, { errors, warnings });

  for (const w of warnings) log.warn(w);

  if (errors.length && throwOnError) {
    log.fatal('configuration is invalid', { problems: errors.length });
    throw new ConfigError(
      `Configuration is invalid:\n  - ${errors.join('\n  - ')}\n\n` +
      'Copy elastibot.yml.example to elastibot.yml and fill it in.'
    );
  }

  if (!errors.length) log.debug('configuration validated', { warnings: warnings.length });

  return { errors, warnings };
}

module.exports = { validateConfig };