'use strict';

/*
 * Case naming scheme:
 *   part1 - space name:  1 word  > first three letters
 *                        2+ words > initials
 *   part2 - date:        MMDDYY
 *   part3 - rule name
 *   joined by dashes:  PART1-MMDDYY-Rule Name
 *
 */

/** First letter of each word */
function initials(name) {
  return name
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

function datePart(date = new Date()) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  return `${mm}${dd}${yy}`;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** month and year used as a case tag, e.g. "July 2026" */
function monthYearTag(date = new Date()) {
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function partThree(ruleName, truncateRuleWords) {
  const name = String(ruleName || 'Unknown Rule').trim();
  if (Number.isInteger(truncateRuleWords) && truncateRuleWords > 0) {
    return name.split(/\s+/).slice(0, truncateRuleWords).join(' ');
  }
  return name;
}

/**
 * @param {string} spaceName space name (display name)
 * @param {string} ruleName  detection rule name
 * @param {object} [opts]    { date, truncateRuleWords }
 */
function buildCaseTitle(spaceName, ruleName, opts = {}) {
  const { date = new Date(), truncateRuleWords = null } = opts;
  return `${partOne(spaceName)}-${datePart(date)}-${partThree(ruleName, truncateRuleWords)}`;
}

module.exports = { buildCaseTitle, monthYearTag, partOne, datePart, partThree, initials };