'use strict';

const { esc, code, mrkdwnLink, ruleBreakdown } = require('../src/util/mrkdwn');

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