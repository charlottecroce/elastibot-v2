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
 * Text that is safe to put inside a ``` fence.
 *
 * Slack does NOT interpret mrkdwn inside a fence, so this takes no esc() - the
 * hazard is different. A stray backtick closes the fence early and spills the
 * rest of the block into the message as prose; a newline breaks the alignment
 * of a table or splits one copy-pasteable command into two.
 *
 * Backticks and newlines collapse to a SINGLE SPACE, which is what you want for
 * display text: a rule name wrapped across two lines reads as
 * "Suspicious PowerShell", not "SuspiciousPowerShell". For anything that will
 * be parsed as a single command argument, use fenceSafeToken instead.
 *
 * @param {*} value
 * @param {object} [opts]
 * @param {number} [opts.max] truncate to this many characters, ellipsis included.
 *   Omit (or 0) to leave the length alone
 * @param {string} [opts.separator] what the stripped characters collapse to
 */
function fenceSafe(value, { max = 0, separator = ' ' } = {}) {
  const one = String(value ?? '')
    .replace(/[`\r\n]+/g, separator)
    .trim();
  return max > 0 && one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * Fence-safe text for something that has to survive as ONE whitespace-delimited
 * token - a case id or alert id inside a ready-to-run `/add_alert` command.
 *
 * Deletes rather than collapsing, and that is a correctness difference, not a
 * stylistic one. `/add_alert case-1 a2 whoami` parses as three arguments, so
 * the handler runs against alert `a2` - a different alert, attached silently
 * and successfully. `/add_alert case-1 a2whoami` is one argument that resolves
 * to nothing and fails loudly, which is the right outcome for an id that was
 * malformed to begin with.
 *
 * @param {*} value
 * @param {object} [opts]
 * @param {number} [opts.max] as fenceSafe
 */
function fenceSafeToken(value, { max = 0 } = {}) {
  return fenceSafe(value, { max, separator: '' });
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

module.exports = { esc, code, fenceSafe, fenceSafeToken, mrkdwnLink, ruleBreakdown };