'use strict';

/*
 * /stats settings and their boot-time checks.
 *
 * REQUIRED BY config/index.js AT REQUIRE TIME. Do not require ../../../config
 * here, and do not require anything that does. The `s` accessor is the config
 * accessor; it arrives as an argument for exactly that reason.
 *
 * One namespace, kept at the config root under the name it already had, so every
 * `config.stats.*` reference in statsService.js and statsBlocks.js resolves
 * unchanged.
 *
 * Note that features/cases/config.js also reads `stats.timezone` as the fallback
 * for its case-title timezone. That is a config KEY being read through `s`, not
 * a feature importing another feature - but it does mean renaming this yaml key
 * would silently change case titles, so don't.
 */

const FIELD_NAME_RE = /^[a-zA-Z0-9_.@*-]+$/;

/**
 * @param {function} s  s(yamlKey, ENV_VAR, coerce, default), coercers on s.coercers
 */
function defaults(s) {
  const { str, int } = s.coercers;

  return {
    stats: {
      // Lookback used by /stats when the analyst doesn't pass one ('24h', '7d', '2w')
      defaultWindow: s('stats.default_window', 'STATS_DEFAULT_WINDOW', str, '7d'),
      // Hard cap on how far back /stats will look
      maxWindowDays: s('stats.max_window_days', 'STATS_MAX_WINDOW_DAYS', int, 90),
      // Timezone used to bucket alerts into hours/weekdays. 'UTC' or an IANA name.
      // Set it to your SOC's timezone or "busiest hour" doesn't mean anything
      timeZone: s('stats.timezone', 'STATS_TIMEZONE', str, 'UTC'),
      // How many entries each "top N" list shows
      topN: s('stats.top_n', 'STATS_TOP_N', int, 10),
      // Minimum alerts before a rule can appear in the "noisiest" list
      noiseMinAlerts: s('stats.noise_min_alerts', 'STATS_NOISE_MIN_ALERTS', int, 10),
      // Field holding the process/program name. Override if your alerts use a
      // different mapping (e.g. 'process.executable'). Validated at boot, because
      // a field that is `text` rather than `keyword` fails the whole aggregation
      processField: s('stats.process_field', 'STATS_PROCESS_FIELD', str, 'process.name'),
    },
  };
}

/** Boot-time checks. Push onto the arrays; never throw */
function validate(config, { errors, warnings }) {
  const stats = config.stats || {};

  const positiveInt = (value, name) => {
    if (!Number.isInteger(value) || value <= 0) {
      errors.push(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
    }
  };

  positiveInt(stats.maxWindowDays, 'STATS_MAX_WINDOW_DAYS');
  positiveInt(stats.topN, 'STATS_TOP_N');
  positiveInt(stats.noiseMinAlerts, 'STATS_NOISE_MIN_ALERTS');

  if (stats.timeZone && stats.timeZone !== 'UTC') {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: stats.timeZone });
    } catch {
      errors.push(`STATS_TIMEZONE is not a recognised IANA timezone: ${JSON.stringify(stats.timeZone)}`);
    }
  }

  if (!FIELD_NAME_RE.test(String(stats.processField || ''))) {
    errors.push(
      `STATS_PROCESS_FIELD is not a valid field name: ${JSON.stringify(stats.processField)}`
    );
  }

  if (!/^(\d+)(m|h|d|w)$/i.test(String(stats.defaultWindow || ''))) {
    errors.push(
      'STATS_DEFAULT_WINDOW must look like 24h, 7d or 2w - got ' +
      JSON.stringify(stats.defaultWindow)
    );
  }

  if (stats.topN > 25) {
    warnings.push(
      `STATS_TOP_N is ${stats.topN} - a table that long pushes the message past Slack's ` +
      '3000-character section limit'
    );
  }
}

module.exports = { defaults, validate };