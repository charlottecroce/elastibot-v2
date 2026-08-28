'use strict';

/*
 * Identifiers shared across module boundaries. Anything that has to match
 * between a producer and a consumer (a button and its handler, a manifest entry
 * and a command registration, a state file key and its reader) lives here
 */

/*
 * Slack action_ids (buttons, selects)
 */
const ACTIONS = Object.freeze({
  CREATE_CASE_FROM_ALERT: 'create_case_from_alert',
  // "Add N new alerts to case" - attaches everything on an incident message
  // that isn't on its case yet
  ADD_ALERTS_TO_CASE: 'add_alerts_to_case',
  // /start's radio input toggling between "paste my own key" and "create one
  // for me" - swaps the modal's blocks via views.update
  START_METHOD_SELECT: 'start_method_select',

  // /sigma - the space picker shown before anything is read or written
  SIGMA_SPACE_SELECT: 'sigma_space_select',
  // Back / Next on a paged result set. The value carries the target page
  SIGMA_PAGE: 'sigma_page',
  SIGMA_RULE_UPDATE: 'sigma_rule_update',
  SIGMA_RULE_ADD: 'sigma_rule_add',
  // A link button. It has a handler only so Bolt stops warning about an
  // unhandled interaction on every click
  SIGMA_RULE_VIEW: 'sigma_rule_view',
});

/** Slack view callback_ids (modals) */
const VIEWS = Object.freeze({
  START_SUBMIT: 'elastibot_start_submit',
});

/** Slash commands - must match manifest.yml */
const COMMANDS = Object.freeze({
  START: '/start',
  CASE: '/case',
  ADD_ALERT: '/add_alert',
  STATS: '/stats',
  SIGMA: '/sigma',
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

/** The label used when an alert has no rule name */
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