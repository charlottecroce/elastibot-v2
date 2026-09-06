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
 * TIMEZONE: every date here is rendered in an explicit IANA zone, so the same
 * alert produces the same case title whatever region the process runs in.
 * caseService passes config.naming.timeZone, which is always set (it defaults
 * to 'UTC'), so there is no host-local fallback to fall into by accident
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

/** Pull named parts out of an Intl format, e.g. get('month') */
function partsOf(date, options) {
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date);
  return (type) => parts.find((p) => p.type === type)?.value || '';
}

/**
 * MMDDYY in the given zone.
 *
 * @param {Date} date
 * @param {string} timeZone IANA zone, e.g. 'America/New_York' or 'UTC'
 */
function datePart(date, timeZone) {
  const get = partsOf(date, {
    timeZone,
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  });
  return `${get('month')}${get('day')}${get('year')}`;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Month and year used as a case tag, e.g. "July 2026"
 *
 * @param {Date} date
 * @param {string} timeZone
 */
function monthYearTag(date, timeZone) {
  const get = partsOf(date, { timeZone, year: 'numeric', month: 'numeric' });
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
 * @param {object} opts
 * @param {string} opts.timeZone            required - see the TIMEZONE note above
 * @param {Date}   [opts.date]
 * @param {number|null} [opts.truncateRuleWords]
 */
function buildCaseTitle(spaceName, ruleName, { timeZone, date = new Date(), truncateRuleWords = null } = {}) {
  return `${partOne(spaceName)}-${datePart(date, timeZone)}-${partThree(ruleName, truncateRuleWords)}`;
}

module.exports = { buildCaseTitle, monthYearTag, partOne, datePart, partThree, initials };