'use strict';

/*
 * Identifiers core owns. A feature's ids live in its own folder.
 */

/** Slack action_ids (buttons, selects) that core registers */
const ACTIONS = Object.freeze({
  // /start's radio input toggling between "paste my own key" and "create one
  // for me" - swaps the modal's blocks via views.update
  START_METHOD_SELECT: 'start_method_select',
});

/** Slack view callback_ids (modals) */
const VIEWS = Object.freeze({
  START_SUBMIT: 'elastibot_start_submit',
});

/** Slash commands core owns - must match manifest.yml */
const COMMANDS = Object.freeze({
  START: '/start',
});

/** The un-prefixed Kibana space. Core owns it because spacePath() depends on it */
const DEFAULT_SPACE = 'default';

/** The label used when an alert has no rule name. See the header before moving */
const UNKNOWN_RULE = 'Unknown Rule';

module.exports = {
  ACTIONS,
  VIEWS,
  COMMANDS,
  DEFAULT_SPACE,
  UNKNOWN_RULE,
};