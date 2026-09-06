'use strict';

const { ConfigError } = require('../src/core/util/errors');
const { isAbsoluteHttpUrl } = require('../src/core/util/url');
const { logger } = require('../src/core/util/logger');
const { validateFeatureConfig } = require('../src/features/config');

/*
 * Config validation. Collects every problem before throwing, so an operator
 * fixes one round of mistakes instead of one mistake per restart.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED IN THE CORE-PLUS-FEATURES MOVE
 * ---------------------------------------------------------------------------
 * The --- Naming ---, --- Stats --- and --- Sigma --- sections are gone from
 * this file. They now live in each feature's config.js next to the defaults they
 * check, which is the point: a setting and its validation should not be able to
 * drift across a folder boundary, and deleting a feature should delete its
 * validation with it.
 *
 * The collect-everything behaviour survives the split intact. Feature validators
 * are handed the SAME errors and warnings arrays, so a bad sigma page size and a
 * missing Slack token still come out of one boot together.
 *
 * Feature validators run even for disabled features. A setting that is wrong in
 * the file is worth reporting before somebody switches the feature on and hits
 * it at three in the morning.
 */

const log = logger.child({ scope: 'config' });

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
const LOG_FORMATS = ['json', 'pretty'];

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

  // --- Elastic, logging, security, cache, watchers: unchanged, elided here ---
  url(config.elastic.kibanaUrl, 'KIBANA_URL');
  url(config.elastic.esUrl, 'ELASTICSEARCH_URL');
  oneOf(config.logging.level, LOG_LEVELS, 'LOG_LEVEL');
  oneOf(config.logging.format, LOG_FORMATS, 'LOG_FORMAT');

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