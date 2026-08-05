'use strict';

const {
  buildCaseTitle,
  monthYearTag,
  partOne,
  datePart,
  partThree,
  initials,
} = require('../src/naming');

/*
 * Dates are constructed from UTC instants and rendered in an explicit zone
 */

const JUL_4 = new Date('2026-07-04T12:00:00Z');

describe('partOne (space prefix)', () => {
  test('one word > first three letters, uppercased', () => {
    expect(partOne('default')).toBe('DEF');
    expect(partOne('soc')).toBe('SOC');
  });

  test('two or more words > initials', () => {
    expect(partOne('Security Operations')).toBe('SO');
    expect(partOne('North America Threat Intel')).toBe('NATI');
  });

  test('punctuation is ignored, not counted as a letter', () => {
    expect(partOne('#soc-team')).toBe('SOC');
    expect(partOne('(west) region')).toBe('WR');
  });

  test('missing or empty space name degrades to an empty prefix', () => {
    expect(partOne('')).toBe('');
    expect(partOne(undefined)).toBe('');
  });
});

describe('initials', () => {
  test('takes the first alphanumeric of each word', () => {
    expect(initials('alpha beta gamma')).toBe('abg');
    expect(initials('  padded   spacing ')).toBe('ps');
  });
});

describe('datePart', () => {
  test('is MMDDYY, zero padded', () => {
    expect(datePart(new Date('2026-01-05T12:00:00Z'), 'UTC')).toBe('010526');
    expect(datePart(new Date('2026-12-31T12:00:00Z'), 'UTC')).toBe('123126');
  });

  test('renders in the zone it is given, not the host zone', () => {
    // 01:00 UTC on the 5th is still the 4th in New York
    const instant = new Date('2026-01-05T01:00:00Z');
    expect(datePart(instant, 'UTC')).toBe('010526');
    expect(datePart(instant, 'America/New_York')).toBe('010426');
  });
});

describe('partThree (rule name)', () => {
  test('passes the rule through untouched by default', () => {
    expect(partThree('Suspicious PowerShell Download', null)).toBe(
      'Suspicious PowerShell Download'
    );
  });

  test('truncates to N words when configured', () => {
    expect(partThree('Suspicious PowerShell Download Activity', 2)).toBe('Suspicious PowerShell');
  });

  test('falls back to Unknown Rule', () => {
    expect(partThree(undefined, null)).toBe('Unknown Rule');
    expect(partThree('', null)).toBe('Unknown Rule');
  });
});

describe('buildCaseTitle', () => {
  test('joins prefix, date and rule with dashes', () => {
    const title = buildCaseTitle('Security Operations', 'Malware Detected', {
      date: JUL_4,
      timeZone: 'UTC',
    });
    expect(title).toBe('SO-070426-Malware Detected');
  });

  test('honours truncateRuleWords', () => {
    const title = buildCaseTitle('default', 'One Two Three Four', {
      date: JUL_4,
      timeZone: 'UTC',
      truncateRuleWords: 2,
    });
    expect(title).toBe('DEF-070426-One Two');
  });

  test('the same instant yields the same title whatever zone is configured', () => {
    const utc = buildCaseTitle('default', 'Rule', { date: JUL_4, timeZone: 'UTC' });
    const tokyo = buildCaseTitle('default', 'Rule', { date: JUL_4, timeZone: 'Asia/Tokyo' });
    // Both are deterministic; they differ only because the zones genuinely do
    expect(utc).toBe('DEF-070426-Rule');
    expect(tokyo).toBe('DEF-070426-Rule');
  });
});

describe('monthYearTag', () => {
  test('is the full month name and year', () => {
    expect(monthYearTag(new Date('2026-07-30T12:00:00Z'), 'UTC')).toBe('July 2026');
    expect(monthYearTag(new Date('2026-01-01T12:00:00Z'), 'UTC')).toBe('January 2026');
  });

  test('respects the zone at a month boundary', () => {
    // 23:00 UTC on 31 July is already August in Tokyo
    const instant = new Date('2026-07-31T23:00:00Z');
    expect(monthYearTag(instant, 'UTC')).toBe('July 2026');
    expect(monthYearTag(instant, 'Asia/Tokyo')).toBe('August 2026');
  });
});