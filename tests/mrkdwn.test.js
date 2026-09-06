'use strict';

const {
  esc,
  code,
  fenceSafe,
  fenceSafeToken,
  mrkdwnLink,
  ruleBreakdown,
} = require('../src/util/mrkdwn');

describe('esc', () => {
  test('escapes the three mrkdwn-special characters', () => {
    expect(esc('a & b <script> c')).toBe('a &amp; b &lt;script&gt; c');
  });

  test('escapes the ampersand first, so entities are not double-encoded', () => {
    expect(esc('<')).toBe('&lt;');
    expect(esc('&lt;')).toBe('&amp;lt;');
  });

  test('null and undefined become empty strings', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  test('non-strings are coerced rather than thrown at', () => {
    expect(esc(42)).toBe('42');
    expect(esc(false)).toBe('false');
  });
});

describe('code', () => {
  test('wraps in backticks and escapes the contents', () => {
    expect(code('web-01')).toBe('`web-01`');
    expect(code('<b>')).toBe('`&lt;b&gt;`');
  });
});

describe('fenceSafe', () => {
  test('strips backticks so a table or command list cannot escape its fence', () => {
    expect(fenceSafe('rm -rf `whoami`')).not.toContain('`');
  });

  test('collapses newlines to a space rather than joining the words', () => {
    expect(fenceSafe('one\ntwo')).toBe('one two');
    expect(fenceSafe('one\r\n\r\ntwo')).toBe('one two');
  });

  test('truncates to max, ellipsis included, only when asked', () => {
    expect(fenceSafe('x'.repeat(50), { max: 10 })).toHaveLength(10);
    expect(fenceSafe('x'.repeat(50))).toHaveLength(50);
  });

  test('leaves anything already short enough exactly as it is', () => {
    expect(fenceSafe('Rule A', { max: 34 })).toBe('Rule A');
  });

  test('trims, so a padded label does not shift a column', () => {
    expect(fenceSafe('  Rule A  ')).toBe('Rule A');
  });

  test('null and undefined become empty strings, not "null"', () => {
    expect(fenceSafe(null)).toBe('');
    expect(fenceSafe(undefined)).toBe('');
  });

  test('does NOT escape - a fence is not interpreted as mrkdwn', () => {
    // The opposite of esc: angle brackets inside a fence are literal already,
    // and escaping them would print "&lt;" to the analyst
    expect(fenceSafe('a < b & c')).toBe('a < b & c');
  });
});

/*
 * The token variant, and the reason it is not just fenceSafe with a different
 * default. Its output goes into a command an analyst copies and runs, so a
 * separator that splits one argument into two does not produce a broken
 * command - it produces a working command aimed at something else
 */
describe('fenceSafeToken', () => {
  test('deletes rather than collapsing, so an id stays one argument', () => {
    expect(fenceSafeToken('a2`whoami`')).toBe('a2whoami');
    expect(fenceSafeToken('a2\nb3')).toBe('a2b3');
  });

  test('the result contains no whitespace for the command parser to split on', () => {
    expect(fenceSafeToken('a2`x`b3')).not.toMatch(/\s/);
  });

  test('leaves a well-formed id exactly as it is', () => {
    const uuid = '8f14e45f-ceea-467a-9c1b-4d5c3f1a2b7e';
    expect(fenceSafeToken(uuid)).toBe(uuid);
  });

  test('still truncates when asked', () => {
    expect(fenceSafeToken('x'.repeat(50), { max: 10 })).toHaveLength(10);
  });

  test('null and undefined become empty strings', () => {
    expect(fenceSafeToken(null)).toBe('');
    expect(fenceSafeToken(undefined)).toBe('');
  });
});

describe('mrkdwnLink', () => {
  test('builds a Slack link when there is a url', () => {
    expect(mrkdwnLink('https://x/y', 'Case 1')).toBe('<https://x/y|Case 1>');
  });

  test('degrades to plain text rather than printing "undefined" into a channel', () => {
    expect(mrkdwnLink(null, 'Case 1')).toBe('Case 1');
    expect(mrkdwnLink(undefined, 'Case 1')).toBe('Case 1');
    expect(mrkdwnLink('', 'Case 1')).toBe('Case 1');
  });

  test('escapes the label in both branches', () => {
    expect(mrkdwnLink('https://x', 'A & B')).toBe('<https://x|A &amp; B>');
    expect(mrkdwnLink(null, 'A & B')).toBe('A &amp; B');
  });
});

describe('ruleBreakdown', () => {
  test('renders counts', () => {
    expect(ruleBreakdown({ Malware: 3, Beaconing: 1 })).toBe('Malware ×3, Beaconing ×1');
  });

  test('orders by count descending regardless of insertion order', () => {
    // The message is re-rendered on every poll tick; insertion order would make
    // the list reshuffle under an analyst mid-read
    expect(ruleBreakdown({ Beaconing: 1, Malware: 3 })).toBe('Malware ×3, Beaconing ×1');
  });

  test('breaks ties by name, so the order is total', () => {
    expect(ruleBreakdown({ Zeta: 2, Alpha: 2 })).toBe('Alpha ×2, Zeta ×2');
  });

  test('falls back to the representative rule when there are no counts', () => {
    expect(ruleBreakdown({}, 'Malware')).toBe('Malware');
    expect(ruleBreakdown(null, 'Malware')).toBe('Malware');
    expect(ruleBreakdown(undefined, 'Malware')).toBe('Malware');
  });

  test('falls back to Unknown Rule when there is nothing at all', () => {
    expect(ruleBreakdown({})).toBe('Unknown Rule');
    expect(ruleBreakdown({}, '')).toBe('Unknown Rule');
  });

  test('escapes rule names', () => {
    expect(ruleBreakdown({ 'R&D <exfil>': 1 })).toBe('R&amp;D &lt;exfil&gt; ×1');
  });
});