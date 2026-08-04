'use strict';

/*
 * Identifiers shared across module boundaries.
 *
 */

/** Slack action_ids (buttons, selects) */
const ACTIONS = Object.freeze({
  CREATE_CASE_FROM_ALERT: 'create_case_from_alert',
});

/** Slack view callback_ids (modals) */
const VIEWS = Object.freeze({
  START_SUBMIT: 'elastibot_start_submit',
});

/** Slash commands */
const COMMANDS = Object.freeze({
  START: '/start',
  CASE: '/case',
  ADD_ALERT: '/add_alert',
  STATS: '/stats',
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

const DEFAULT_SPACE = 'default';

/*
 * The label used when an alert has no rule name.
 */
const UNKNOWN_RULE = 'Unknown Rule';

/*
 * Alert severity ordering. Anything not listed ranks below everything listed,
 * so an unrecognised severity never outranks a real one
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
  VIEWS,
  COMMANDS,
  STATE_KEYS,
  ALERT_STATUS_FOR_CASE,
  DEFAULT_SPACE,
  UNKNOWN_RULE,
  SEVERITY_RANK,
};