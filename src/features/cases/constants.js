'use strict';

/*
 * The cases feature's ids.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE TWO SETS OF ACTION IDS
 * ---------------------------------------------------------------------------
 * The loader requires action ids to be namespaced ("cases:create_case") and
 * asserts they are globally unique. Renaming them is safe for /sigma, whose
 * messages are ephemeral with a fifteen-minute pager TTL behind them. It is NOT
 * safe here.
 *
 * An incident message is posted in-channel and sits there indefinitely. Its
 * buttons carry the action_id in their payload forever. Deploying the rename on
 * its own orphans every incident message currently in the channel: an analyst
 * clicks Create case on last night's burst, Bolt has no handler for
 * "create_case_from_alert", and nothing happens at all.
 *
 * So both ids are registered against the same handler for one release. LEGACY is
 * listed in the descriptor's legacyActionIds, which is what exempts it from the
 * namespace assertion - a deliberate, visible entry with a date on it in the
 * commit, rather than a quietly relaxed rule.
 *
 * DELETE THE LEGACY BLOCK once every incident older than INCIDENT_MAX_LIFETIME_MS
 * from the deploy has been reaped - 24h by default, so the release after next.
 *
 * UNKNOWN_RULE is deliberately NOT here. It lives in core/constants.js because
 * core/elastic/alerts.js and core/util/mrkdwn.js both use it; defining a second
 * copy here is how the two drift.
 */

/** Slack action_ids. Namespaced, asserted unique by the loader at boot */
const ACTIONS = Object.freeze({
  CREATE_CASE_FROM_ALERT: 'cases:create_case_from_alert',
  // "Add N new alerts to case" - attaches everything on an incident message
  // that isn't on its case yet
  ADD_ALERTS_TO_CASE: 'cases:add_alerts_to_case',
});

/** The pre-namespace ids, still live in posted messages. See the header */
const LEGACY_ACTIONS = Object.freeze({
  CREATE_CASE_FROM_ALERT: 'create_case_from_alert',
  ADD_ALERTS_TO_CASE: 'add_alerts_to_case',
  /*
   * There is no namespaced counterpart for this one on purpose. The renderer
   * emits no view-case button in any state any more - incidentBlocks.test.js
   * asserts it - but messages posted before it was removed still carry the id,
   * and an unhandled interaction logs a Bolt warning on every click. So it gets
   * a no-op handler under the old id only.
   *
   * commands/case.js used to register `ACTIONS.VIEW_CASE`, which does not exist
   * in this file, so the id it handed Bolt was literally `undefined`.
   */
  VIEW_CASE: 'view_case',
});

/** Slash commands - must match manifest.yml */
const COMMANDS = Object.freeze({
  CASE: '/case',
  ADD_ALERT: '/add_alert',
});

/** Keys in data/state.json */
const STATE_KEYS = Object.freeze({
  ALERTS_LAST_TS: 'alertsLastTs',
  CASES_LAST_TS: 'casesLastTs', // { [spaceId]: iso }
});

/** Kibana case status > alert workflow status */
const ALERT_STATUS_FOR_CASE = Object.freeze({
  open: 'open',
  'in-progress': 'acknowledged',
  closed: 'closed',
});

/*
 * Alert severity ordering. Anything not listed ranks below everything listed,
 * so an unrecognised severity never outranks a real one.
 *
 * Moved out of core: grouping.js and incidentBlocks.js are its only readers and
 * both are in this feature.
 */
const SEVERITY_RANK = Object.freeze({
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
});

module.exports = {
  ACTIONS,
  LEGACY_ACTIONS,
  COMMANDS,
  STATE_KEYS,
  ALERT_STATUS_FOR_CASE,
  SEVERITY_RANK,
};