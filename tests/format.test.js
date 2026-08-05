'use strict';

const {
  caseUrl,
  esc,
  plain,
  num,
  bar,
  sparkline,
  countTable,
  caseCreatedBlocks,
  alertAddedBlocks,
  alertGroupBlocks,
} = require('../src/services/format');

/*
 * caseUrl is the one people notice when it breaks (a link that 404s or bounces
 * an analyst through a login), and the block builders have to keep producing
 * shapes Slack will accept
 */

describe('caseUrl', () => {
  test('default space has no /s/ prefix', () => {
    expect(caseUrl('default', 'case-1', 'securitySolution')).toBe(
      'https://kibana.example.com/app/security/cases/case-1'
    );
  });

  test('non-default space is prefixed', () => {
    expect(caseUrl('soc', 'case-1', 'securitySolution')).toBe(
      'https://kibana.example.com/s/soc/app/security/cases/case-1'
    );
  });

  test('owner picks the solution app', () => {
    expect(caseUrl('default', 'c', 'observability')).toContain('/app/observability/cases/');
    expect(caseUrl('default', 'c', 'cases')).toContain(
      '/app/management/insightsAndAlerting/cases/'
    );
  });

  test('space id and case id are url encoded', () => {
    expect(caseUrl('my space', 'a/b', 'securitySolution')).toBe(
      'https://kibana.example.com/s/my%20space/app/security/cases/a%2Fb'
    );
  });

  test('prefers KIBANA_PUBLIC_URL over KIBANA_URL', () => {
    expect(caseUrl('default', 'c', 'securitySolution')).toContain('kibana.example.com');
    expect(caseUrl('default', 'c', 'securitySolution')).not.toContain('kibana.internal');
  });

  test('a trailing slash on the base url does not double up', () => {
    const previous = process.env.KIBANA_PUBLIC_URL;
    process.env.KIBANA_PUBLIC_URL = 'https://kibana.example.com/';
    jest.resetModules();
    const fresh = require('../src/services/format');
    expect(fresh.caseUrl('default', 'c', 'securitySolution')).toBe(
      'https://kibana.example.com/app/security/cases/c'
    );
    process.env.KIBANA_PUBLIC_URL = previous;
    jest.resetModules();
  });
});

describe('esc', () => {
  test('escapes the three mrkdwn-special characters', () => {
    expect(esc('a & b <script> c')).toBe('a &amp; b &lt;script&gt; c');
  });

  test('null and undefined become empty strings', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
});

describe('code-block helpers', () => {
  test('plain strips backticks so a table cannot escape its fence', () => {
    expect(plain('rm -rf `whoami`')).not.toContain('`');
  });

  test('plain collapses newlines and truncates', () => {
    expect(plain('one\ntwo')).toBe('one two');
    expect(plain('x'.repeat(50), 10)).toHaveLength(10);
  });

  test('num groups thousands', () => {
    expect(num(1204)).toBe('1,204');
    expect(num(1000000)).toBe('1,000,000');
    expect(num(0)).toBe('0');
  });

  test('bar is a fixed width and any non-zero value shows something', () => {
    expect(bar(10, 10, 8)).toBe('████████');
    expect(bar(0, 10, 8)).toBe('        ');
    expect(bar(1, 1000, 8)).toHaveLength(8);
    expect(bar(1, 1000, 8).trim()).toBe('█');
  });

  test('sparkline is one char per value and peaks at the max', () => {
    const line = sparkline([0, 1, 5, 10]);
    expect(line).toHaveLength(4);
    expect(line[0]).toBe(' ');
    expect(line[3]).toBe('█');
  });

  test('countTable aligns rows inside a fence', () => {
    const table = countTable([
      { label: 'Rule A', count: 100 },
      { label: 'A Much Longer Rule Name', count: 5 },
    ]);
    expect(table.startsWith('```')).toBe(true);
    // the bars have to start in the same column on every row
    const [a, b] = table.split('\n').slice(1, 3);
    expect(a.indexOf('█')).toBe(b.indexOf('█'));
    expect(a).toContain('100');
  });

  test('countTable handles an empty list', () => {
    expect(countTable([])).not.toContain('```');
  });
});

describe('caseCreatedBlocks', () => {
  test('single alert shows Rule, not Rules, and no alert count', () => {
    const blocks = caseCreatedBlocks({
      title: 'SO-070426-Malware',
      caseId: 'case-1',
      spaceName: 'Security Operations',
      ruleName: 'Malware',
      alertCount: 1,
      link: 'https://kibana.example.com/app/security/cases/case-1',
      slackUserId: 'U123',
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain('*Rule:*');
    expect(text).not.toContain('*Rules:*');
    expect(text).not.toContain('*Alerts:*');
    expect(text).toContain('<@U123>');
  });

  test('grouped case shows the alert count and per-rule breakdown', () => {
    const blocks = caseCreatedBlocks({
      title: 'SO-070426-Malware',
      caseId: 'case-1',
      spaceName: 'Security Operations',
      ruleName: 'Malware',
      ruleCounts: { Malware: 3, Beaconing: 1 },
      alertCount: 4,
      link: 'https://x/y',
      slackUserId: 'U123',
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain('*Alerts:* 4');
    expect(text).toContain('Malware ×3, Beaconing ×1');
  });

  test('a warning is appended only when there is one', () => {
    const clean = caseCreatedBlocks({ caseId: 'c', alertCount: 1, slackUserId: 'U' });
    const warned = caseCreatedBlocks({
      caseId: 'c',
      alertCount: 1,
      slackUserId: 'U',
      warning: "Some alerts didn't attach",
    });
    expect(warned).toHaveLength(clean.length + 1);
    expect(JSON.stringify(warned)).toContain(':warning:');
  });

  test('a rule name with mrkdwn characters is escaped', () => {
    const blocks = caseCreatedBlocks({
      caseId: 'c',
      ruleName: '<script>alert(1)</script>',
      alertCount: 1,
      slackUserId: 'U',
    });
    expect(JSON.stringify(blocks)).not.toContain('<script>');
  });
});

describe('alertAddedBlocks', () => {
  test('mentions the user, alert, rule and case link', () => {
    const text = JSON.stringify(
      alertAddedBlocks({
        caseId: 'case-1',
        alertId: 'alert-1',
        ruleName: 'Malware',
        link: 'https://x/y',
        slackUserId: 'U123',
      })
    );
    expect(text).toContain('<@U123>');
    expect(text).toContain('alert-1');
    expect(text).toContain('https://x/y');
  });
});

describe('alertGroupBlocks', () => {
  test('a single alert renders the plain notification with a Create case button', () => {
    const blocks = alertGroupBlocks({
      count: 1,
      representativeRule: 'Malware',
      topSeverity: 'high',
      spaceName: 'default',
      from: '2026-07-30T12:00:00.000Z',
      alertId: 'alert-1',
    });
    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions.elements[0].text.text).toBe('Create case');
    expect(actions.elements[0].value).toBe('alert-1');
    expect(JSON.stringify(blocks)).toContain('*New alert*');
  });

  test('a burst renders the rollup and the count on the button', () => {
    const blocks = alertGroupBlocks({
      count: 5,
      representativeRule: 'Malware',
      ruleCounts: { Malware: 4, Beaconing: 1 },
      topSeverity: 'critical',
      userName: 'jsmith',
      hostName: 'web-01',
      spaceName: 'default',
      from: 'a',
      to: 'b',
      alertId: 'alert-1',
      buttonValue: '{"k":"g"}',
    });
    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions.elements[0].text.text).toBe('Create case (5 alerts)');
    expect(actions.elements[0].value).toBe('{"k":"g"}');
    expect(JSON.stringify(blocks)).toContain('*5 related alerts*');
  });

  test('user and host lines are omitted when the alert has neither', () => {
    const blocks = alertGroupBlocks({ count: 1, representativeRule: 'R', alertId: 'a' });
    const context = blocks.find((b) => b.type === 'context');
    expect(JSON.stringify(context)).not.toContain('*User:*');
    expect(JSON.stringify(context)).not.toContain('*Host:*');
  });
});