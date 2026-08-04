'use strict';

const {
  buildCaseTitle,
  monthYearTag,
  partOne,
  datePart,
  partThree,
  initials,
} = require('../src/naming');


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
    expect(datePart(new Date(2026, 0, 5))).toBe('010526');
    expect(datePart(new Date(2026, 11, 31))).toBe('123126');
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
      date: new Date(2026, 6, 4),
    });
    expect(title).toBe('SO-070426-Malware Detected');
  });

  test('honours truncateRuleWords', () => {
    const title = buildCaseTitle('default', 'One Two Three Four', {
      date: new Date(2026, 6, 4),
      truncateRuleWords: 2,
    });
    expect(title).toBe('DEF-070426-One Two');
  });
});

describe('monthYearTag', () => {
  test('is the full month name and year', () => {
    expect(monthYearTag(new Date(2026, 6, 30))).toBe('July 2026');
    expect(monthYearTag(new Date(2026, 0, 1))).toBe('January 2026');
  });
});