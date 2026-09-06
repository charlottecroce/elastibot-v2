'use strict';

const { metaFromYaml, parseNdjson } = require('../src/sigma/parse');

/*
 * There is no yaml parser in this project, so metaFromYaml reads four top-level
 * scalars with regexes. That is fine right up until it matches a nested key by
 * accident and files a rule under someone else's id, which is what most of
 * these guard against
 */

const RULE = `title: Suspicious PowerShell Encoded Command
id: 67f113fa-e23d-4271-befa-30113b3e08b1
status: stable
description: |
    Detects powershell with an encoded command
references:
    - https://example.com
logsource:
    category: process_creation
    product: windows
detection:
    selection:
        Image|endswith: '\\powershell.exe'
    condition: selection
level: high
`;

describe('metaFromYaml', () => {
  test('pulls out the fields we index on', () => {
    expect(metaFromYaml(RULE)).toEqual({
      id: '67f113fa-e23d-4271-befa-30113b3e08b1',
      title: 'Suspicious PowerShell Encoded Command',
      level: 'high',
      status: 'stable',
    });
  });

  test('a nested id is not mistaken for the rule id', () => {
    const nested = 'title: X\ndetection:\n    selection:\n        id: 11111111-1111-1111-1111-111111111111\n';
    expect(metaFromYaml(nested).id).toBeNull();
  });

  test('a quoted title loses its quotes', () => {
    expect(metaFromYaml('title: "Quoted: Title"\n').title).toBe('Quoted: Title');
  });

  test('an uppercase uuid is normalised, because that is the join key', () => {
    expect(metaFromYaml('id: 67F113FA-E23D-4271-BEFA-30113B3E08B1\n').id).toBe(
      '67f113fa-e23d-4271-befa-30113b3e08b1'
    );
  });

  test('a file with no id is reported as having none rather than throwing', () => {
    expect(metaFromYaml('title: No id here\n').id).toBeNull();
  });
});

describe('parseNdjson', () => {
  test('one object per line', () => {
    const rules = parseNdjson('{"rule_id":"a"}\n{"rule_id":"b"}\n');
    expect(rules.map((r) => r.rule_id)).toEqual(['a', 'b']);
  });

  test('blank lines and stray warnings are dropped, not thrown at', () => {
    // sigma-cli occasionally writes a plain-text notice to stdout, and one of
    // those should not cost the whole batch
    const rules = parseNdjson('\nParsing rules...\n{"rule_id":"a"}\n\n');
    expect(rules).toHaveLength(1);
  });

  test('a truncated line is skipped', () => {
    expect(parseNdjson('{"rule_id":"a"\n{"rule_id":"b"}\n')).toHaveLength(1);
  });

  test('empty input is an empty list', () => {
    expect(parseNdjson('')).toEqual([]);
    expect(parseNdjson(null)).toEqual([]);
  });
});