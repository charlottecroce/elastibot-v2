'use strict';

/*
 * The cases feature's settings and their boot-time checks.
 *
 * REQUIRED BY config/index.js AT REQUIRE TIME. Do not require ../../../config
 * here, and do not require anything that does. The `s` accessor arrives as an
 * argument for that reason.
 *
 * Four namespaces, all kept at the config root under the names they already had,
 * so `config.grouping.windowMs` and `config.watchers.pollIntervalMs` still
 * resolve exactly as before and no consumer or test had to change:
 *
 *   grouping    alerts -> incidents
 *   incidents   how long a posted incident stays live
 *   naming      the case title scheme
 *   watchers    the alert and case pollers, and their channel routing
 *
 * `watchers` is a cases namespace in full, including WATCHERS_ENABLED. Every
 * setting in it - the poll interval, the fetch size, the post delay, the channel
 * routing - describes the alert and case pollers specifically, and both of those
 * are this feature's. A second feature with a watcher gets its own interval in
 * its own namespace; the loader gives each watcher its own runner anyway.
 */

/**
 * @param {function} s  s(yamlKey, ENV_VAR, coerce, default), coercers on s.coercers
 */
function defaults(s) {
  const { str, int, num, bool, list, map } = s.coercers;

  return {
    // ---------------------------------------------------------------
    // GROUPING - a burst of alerts from one user on one host is one incident
    // ---------------------------------------------------------------
    grouping: {
      // Measured from the FIRST alert in a cluster, not the previous one, so a
      // slow trickle cannot grow one incident forever
      windowMs: s('grouping.window_ms', 'GROUP_WINDOW_MS', int, 3600000),
      // Ceiling on how many alerts get attached to a single case
      maxAlertsPerCase: s('grouping.max_alerts_per_case', 'GROUP_MAX_ALERTS_PER_CASE', int, 200),
      // Fold machine identities into the human cluster on the same host, so a
      // session that also fires alerts as SYSTEM stays one incident
      mergeMachineUsers: s(
        'grouping.merge_machine_users', 'GROUP_MERGE_MACHINE_USERS', bool, true
      ),
      // Globs matched against the BARE username, domain prefix stripped
      machineUsers: s('grouping.machine_users', 'GROUP_MACHINE_USERS', list, [
        'SYSTEM',
        'LOCAL SERVICE',
        'NETWORK SERVICE',
        'root',
        'svc_*',
        'sa_*',
        '_*',
      ]),
    },

    // ---------------------------------------------------------------
    // INCIDENTS - the lifetime of a posted message
    // ---------------------------------------------------------------
    incidents: {
      // No new alerts for this long and the record is reaped. The next alert on
      // that host starts a fresh incident with a green Create case button, so
      // pick something like a shift length rather than something short
      idleMs: s('incidents.idle_ms', 'INCIDENT_IDLE_MS', int, 8 * 3600000),
      // Hard ceiling regardless of activity
      maxLifetimeMs: s('incidents.max_lifetime_ms', 'INCIDENT_MAX_LIFETIME_MS', int, 24 * 3600000),
      // How long a create-case claim is honoured before it's treated as
      // abandoned. Long enough to cover the Elastic round trips, short enough
      // that a handler dying mid-click doesn't wedge the incident for the shift
      claimTtlMs: s('incidents.claim_ttl_ms', 'INCIDENT_CLAIM_TTL_MS', int, 60000),
    },

    // ---------------------------------------------------------------
    // NAMING - the case title scheme
    // ---------------------------------------------------------------
    naming: {
      // Truncate the rule name in a case title to N words. Unset = use it whole
      truncateRuleWords: s('naming.rule_words', 'CASE_TITLE_RULE_WORDS', int, null),
      /*
       * Pins the title's date so the same alert yields the same case name
       * regardless of the host's local timezone.
       *
       * The fallback reads stats.timezone, which is the stats feature's
       * namespace. That is a config KEY being read, not a feature being
       * imported - `s` resolves any dotted path in elastibot.yml and has no idea
       * who owns it - and it is kept because an operator who set STATS_TIMEZONE
       * once and got consistent case titles for free should not silently start
       * getting UTC ones after a refactor. It is the one place the two features
       * touch, and it is one line.
       */
      timeZone:
        s('naming.timezone', 'CASE_TITLE_TIMEZONE', str, undefined) ||
        s('stats.timezone', 'STATS_TIMEZONE', str, 'UTC'),
    },

    // ---------------------------------------------------------------
    // WATCHERS - the alert and case pollers
    // ---------------------------------------------------------------
    watchers: {
      enabled: s('watchers.enabled', 'WATCHERS_ENABLED', bool, true),
      pollIntervalMs: s('watchers.poll_ms', 'WATCH_POLL_MS', int, 60000),
      // Randomise each interval by +/- this fraction, so two replicas started by
      // the same deploy don't hit Elastic in lockstep forever
      jitterRatio: s('watchers.jitter_ratio', 'WATCH_JITTER_RATIO', num, 0.1),
      // How many new alerts to pull per poll - keep above a plausible burst size
      // so a spike is grouped in one pass instead of split across polls
      fetchSize: s('watchers.fetch_size', 'WATCH_FETCH_SIZE', int, 200),
      // Delay between channel posts within a tick, to stay under Slack's roughly
      // one-message-per-second channel limit
      postDelayMs: s('watchers.post_delay_ms', 'WATCH_POST_DELAY_MS', int, 300),

      // Map an Elastic space ID to the Slack channel ID that should receive its
      // new alerts and cases. Anything unmatched goes to default_channel
      channelRouting: s('watchers.channel_routing', 'WATCH_CHANNEL_ROUTING', map, {}),
      defaultChannel: s('watchers.default_channel', 'DEFAULT_CHANNEL', str, ''),

      alerts: {
        enabled: s('watchers.alerts.enabled', 'WATCH_ALERTS_ENABLED', bool, true),
      },

      cases: {
        enabled: s('watchers.cases.enabled', 'WATCH_CASES_ENABLED', bool, true),
        // Each space keeps its own cursor
        spaces: s('watchers.cases.spaces', 'WATCH_CASE_SPACES', list, ['default']),
        perPage: s('watchers.cases.per_page', 'WATCH_CASES_PER_PAGE', int, 25),
      },
    },
  };
}

/**
 * Boot-time checks. Push onto the arrays; never throw.
 *
 * Runs even when the feature is disabled, so a wrong setting is reported before
 * somebody switches it on.
 */
function validate(config, { errors, warnings }) {
  const positiveInt = (value, name) => {
    if (!Number.isInteger(value) || value <= 0) {
      errors.push(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
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

  // --- Grouping ---
  positiveInt(config.grouping?.windowMs, 'GROUP_WINDOW_MS');
  positiveInt(config.grouping?.maxAlertsPerCase, 'GROUP_MAX_ALERTS_PER_CASE');

  // --- Incidents ---
  positiveInt(config.incidents?.idleMs, 'INCIDENT_IDLE_MS');
  positiveInt(config.incidents?.maxLifetimeMs, 'INCIDENT_MAX_LIFETIME_MS');
  positiveInt(config.incidents?.claimTtlMs, 'INCIDENT_CLAIM_TTL_MS');
  if (
    Number.isInteger(config.incidents?.idleMs) &&
    Number.isInteger(config.incidents?.maxLifetimeMs) &&
    config.incidents.maxLifetimeMs < config.incidents.idleMs
  ) {
    warnings.push(
      'INCIDENT_MAX_LIFETIME_MS is below INCIDENT_IDLE_MS, so the hard ceiling reaps every ' +
      'incident before the idle timer ever fires'
    );
  }

  // --- Naming ---
  timeZone(config.naming?.timeZone, 'CASE_TITLE_TIMEZONE');
  if (config.naming?.truncateRuleWords !== null && config.naming?.truncateRuleWords !== undefined) {
    positiveInt(config.naming.truncateRuleWords, 'CASE_TITLE_RULE_WORDS');
  }

  // --- Watchers ---
  const w = config.watchers || {};
  if (w.enabled) {
    positiveInt(w.pollIntervalMs, 'WATCH_POLL_MS');
    positiveInt(w.fetchSize, 'WATCH_FETCH_SIZE');

    if (!config.elastic?.serviceApiKey) {
      warnings.push(
        'WATCHERS_ENABLED is true but ELASTIC_SERVICE_API_KEY is not set - the watchers will ' +
        'not run at all'
      );
    }

    if (!w.defaultChannel && Object.keys(w.channelRouting || {}).length === 0) {
      warnings.push(
        'no DEFAULT_CHANNEL and no channelRouting entries - the watchers will run and post nothing'
      );
    }

    /*
     * Worst-case Elastic call duration against the poll interval. If one tick
     * can take longer than the gap to the next, ticks get skipped under load and
     * the only symptom is a channel that goes quiet during exactly the incident
     * you care about.
     */
    const worstCase = (config.elastic?.retries + 1) * config.elastic?.requestTimeoutMs;
    if (Number.isFinite(worstCase) && worstCase >= w.pollIntervalMs) {
      warnings.push(
        `a slow Elastic call can take ${worstCase}ms ((ELASTIC_RETRIES + 1) x ` +
        `ELASTIC_TIMEOUT_MS) which is at or above WATCH_POLL_MS (${w.pollIntervalMs}ms) - ` +
        'ticks will be skipped under load'
      );
    }

    if (w.pollIntervalMs < 5000) {
      warnings.push(`WATCH_POLL_MS is ${w.pollIntervalMs} - under 5s is more load for no benefit`);
    }

    // A burst of 50 incidents at 300ms takes 15s, which is fine; at 0 it is a
    // guaranteed 429
    if (w.postDelayMs < 100) {
      warnings.push(
        `WATCH_POST_DELAY_MS is ${w.postDelayMs} - Slack will rate limit a burst. ` +
        'Keep it at 300 or above'
      );
    }

    if (w.cases?.enabled && (w.cases.spaces || []).length === 0) {
      warnings.push('case watcher is enabled but WATCH_CASE_SPACES is empty');
    }
    if (w.cases?.enabled) positiveInt(w.cases.perPage, 'WATCH_CASES_PER_PAGE');
  }
}

module.exports = { defaults, validate };