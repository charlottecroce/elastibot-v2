'use strict';

const { UNKNOWN_RULE } = require('./constants');

/*
 * Case naming scheme:
 *   part1 - space name:  1 word  > first three letters
 *                        2+ words > initials
 *   part2 - date:        MMDDYY
 *   part3 - rule name
 *   joined by dashes:  PART1-MMDDYY-Rule Name
 *
 * TIMEZONE: pass `timeZone` to pin the date to a specific zone. caseService
 * passes config.naming.timeZone, so case titles are deterministic regardless of
 * which region the process runs in. Omitting it falls back to the node
 * process's local zone, which is only appropriate for a one-off call
 */

/** First letter of each word */
function initials(name) {
  return String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const m = word.match(/[A-Za-z0-9]/);
      return m ? m[0] : '';
    })
    .join('');
}

function partOne(spaceName) {
  const words = String(spaceName || '').trim().split(/\s+/).filter(Boolean);
  let out;
  if (words.length >= 2) {
    out = initials(spaceName);
  } else {
    // one word > first three letters
    out = (words[0] || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 3);
  }
  return out.toUpperCase();
}

/**
 * MMDDYY.
 *
 * @param {Date} [date]
 * @param {string|null} [timeZone] IANA zone, e.g. 'America/New_York'. When null
 *   (the default) the process's local timezone is used, preserving existing
 *   behaviour and existing case titles
 */
function datePart(date = new Date(), timeZone = null) {
  if (!timeZone) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const yy = String(date.getFullYear()).slice(-2);
    return `${mm}${dd}${yy}`;
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('month')}${get('day')}${get('year')}`;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** month and year used as a case tag, e.g. "July 2026" */
function monthYearTag(date = new Date(), timeZone = null) {
  if (!timeZone) return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${MONTHS[Number(get('month')) - 1]} ${get('year')}`;
}

function partThree(ruleName, truncateRuleWords) {
  const name = String(ruleName || UNKNOWN_RULE).trim() || UNKNOWN_RULE;
  if (Number.isInteger(truncateRuleWords) && truncateRuleWords > 0) {
    return name.split(/\s+/).slice(0, truncateRuleWords).join(' ');
  }
  return name;
}

/**
 * @param {string} spaceName space name (display name)
 * @param {string} ruleName  detection rule name
 * @param {object} [opts]    { date, truncateRuleWords, timeZone }
 */
function buildCaseTitle(spaceName, ruleName, opts = {}) {
  const { date = new Date(), truncateRuleWords = null, timeZone = null } = opts;
  return `${partOne(spaceName)}-${datePart(date, timeZone)}-${partThree(ruleName, truncateRuleWords)}`;
}

module.exports = { buildCaseTitle, monthYearTag, partOne, datePart, partThree, initials };