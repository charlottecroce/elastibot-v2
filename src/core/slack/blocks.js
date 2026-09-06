'use strict';

const { esc, mrkdwnLink } = require('../util/mrkdwn');

/*
 * Block Kit primitives, for the shapes every feature builds the same way.
 *
 * WHAT IS AND IS NOT IN HERE
 *
 * The rule from the refactor applies to this file more than to any other:
 * second consumer or it stays in the feature. So:
 *
 *   IN  - section, context, divider, button, actions. Three features build all
 *         five, identically, and Slack rejects a malformed one by rejecting the
 *         whole message.
 *
 *   OUT - num, bar, sparkline, countTable. These read like generic helpers and
 *         they are not: statsBlocks is their only consumer, and it is the only
 *         thing in the app that renders a numeric table. They moved to
 *         features/stats/statsBlocks.js with the code that calls them. If a
 *         second feature ever wants a bar chart in a code fence, that is when
 *         they come here.
 *
 *   OUT - the case block builders, incidentMessage, the sigma page blocks. Those
 *         are what a feature IS.
 *
 * `actions()` refusing to emit an empty block is the one piece of behaviour
 * here rather than shape. Slack rejects `elements: []` and the rejection fails
 * the entire chat.update, so one unrenderable button would otherwise take the
 * whole message with it - which is a bug the incident renderer already had once.
 */

/** section block from mrkdwn text */
function section(text) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

/** context block from one or more mrkdwn strings */
function context(...texts) {
  return {
    type: 'context',
    elements: texts.filter(Boolean).map((text) => ({ type: 'mrkdwn', text })),
  };
}

function divider() {
  return { type: 'divider' };
}

/**
 * @param {object} opts
 * @param {string} opts.actionId  namespaced, e.g. "sigma:page"
 * @param {string} opts.text      plain text - Slack does not render mrkdwn on a button
 * @param {string} [opts.value]
 * @param {string} [opts.url]     makes it a link button
 * @param {'primary'|'danger'} [opts.style]
 */
function button({ actionId, text, value, url, style }) {
  return {
    type: 'button',
    action_id: actionId,
    text: { type: 'plain_text', text: String(text), emoji: true },
    ...(value !== undefined ? { value: String(value) } : {}),
    ...(url ? { url } : {}),
    ...(style ? { style } : {}),
  };
}

/**
 * An actions block, or null when there is nothing to put in it.
 *
 * Callers push the result and filter, or use `...actionsOrNothing()`. Returning
 * null rather than an empty block is deliberate - see the header
 */
function actions(elements) {
  const kept = (elements || []).filter(Boolean);
  return kept.length ? { type: 'actions', elements: kept } : null;
}

/** Drop the nulls a conditional block list accumulates */
function compact(blocks) {
  return (blocks || []).filter(Boolean);
}

module.exports = { section, context, divider, button, actions, compact, esc, mrkdwnLink };