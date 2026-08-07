'use strict';

const { UNKNOWN_RULE } = require('../constants');

/*
 * Slack mrkdwn text primitives.
 */

/** Escape the three characters Slack treats as special in mrkdwn */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** An escaped `code span` */
function code(s) {
  return `\`${esc(s)}\``;
}

/**
 * `<url|label>`, or the bare escaped label when there is no usable url.
 *
 * Slack does not validate the url half of a mrkdwn link - it renders
 * `<undefined|Case 1>` as literal text with the word "undefined" in it. A
 * missing link has to degrade to plain text instead
 *
 * @param {string|null} url  absolute http(s) url, or null/'' for no link
 * @param {string} label
 */
function mrkdwnLink(url, label) {
  return url ? `<${url}|${esc(label)}>` : esc(label);
}

/**
 * Render a { ruleName: count } map as "Rule A ×3, Rule B ×1".
 *
 * Sorted by count desc then name asc. The sort is not cosmetic: an incident
 * message is re-rendered in place on every poll tick, and unsorted
 * Object.entries order follows insertion, so the list visibly reshuffles under
 * an analyst who is mid-read. Ties broken by name so the order is total
 *
 * @param {object} ruleCounts
 * @param {string} [fallbackRule] used when the map is empty
 */
function ruleBreakdown(ruleCounts, fallbackRule) {
  const entries = Object.entries(ruleCounts || {}).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
  if (!entries.length) return esc(fallbackRule || UNKNOWN_RULE);
  return entries.map(([name, n]) => `${esc(name)} ×${n}`).join(', ');
}

module.exports = { esc, code, mrkdwnLink, ruleBreakdown };