'use strict';

/*
 * Slack action_ids (buttons, selects)
 */
const ACTIONS = Object.freeze({
  START_METHOD_SELECT: 'start_method_select',
});

/** Slack view callback_ids (modals) */
const VIEWS = Object.freeze({
  START_SUBMIT: 'elastibot_start_submit',
});

/** Slash commands - must match manifest.yml */
const COMMANDS = Object.freeze({
  START: '/start',
});

const DEFAULT_SPACE = 'default';

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
  DEFAULT_SPACE,
  SEVERITY_RANK,
};