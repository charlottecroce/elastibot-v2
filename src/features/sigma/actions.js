'use strict';

/*
 * /sigma's Slack ids.
 *
 * Namespaced with a "sigma:" prefix, which the feature loader asserts at boot
 * along with global uniqueness across every feature. The ids that used to be in
 * src/constants.js under ACTIONS are gone from there; nothing outside this
 * folder refers to them.
 *
 * Renaming these is safe in a way it is NOT safe for the cases feature. A sigma
 * result set is an ephemeral message with a fifteen-minute pager TTL behind it,
 * so the oldest button that can still be clicked after a deploy is minutes old
 * and its session is gone anyway. An incident message is posted in-channel and
 * lives forever - see features/cases/actions.js when you get there.
 */

const ACTIONS = Object.freeze({
  // the space picker shown before anything is read or written
  SPACE_SELECT: 'sigma:space_select',
  // Back / Next on a paged result set. The value carries the target page
  PAGE: 'sigma:page',
  RULE_UPDATE: 'sigma:rule_update',
  RULE_ADD: 'sigma:rule_add',
  // A link button. It has a handler only so Bolt stops warning about an
  // unhandled interaction on every click
  RULE_VIEW: 'sigma:rule_view',
});

/** Slash command. Must match manifest.yml - Slack owns this name, not us */
const COMMAND = '/sigma';

module.exports = { ACTIONS, COMMAND };