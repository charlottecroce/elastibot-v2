'use strict';

const {
  plain,
  num,
  bar,
  sparkline,
  countTable,
  caseCreatedBlocks,
  alertAddedBlocks,
  newCaseBlocks,
} = require('../src/services/format');

/*
 * The block builders have to keep producing shapes Slack will accept.
 *
 * Two describe blocks left this file:
 *   caseUrl          moved with the function to tests/kibanaLinks.test.js
 *   alertGroupBlocks the function was dead - watchers/alerts.js posts through
 *                    incidentMessage, covered by tests/incidentBlocks.test.js
 * The esc cases moved to tests/mrkdwn.test.js along with esc itself
 */

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
    // Ordered by count now that the shared ruleBreakdown sorts
    expect(text).toContain('Malware ×3, Beaconing ×1');
  });

  test('the rule breakdown is ordered by count, not by insertion', () => {
    const blocks = caseCreatedBlocks({
      caseId: 'c',
      ruleName: 'Malware',
      ruleCounts: { Beaconing: 1, Malware: 3 },
      alertCount: 4,
      slackUserId: 'U',
    });
    expect(JSON.stringify(blocks)).toContain('Malware ×3, Beaconing ×1');
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

  test('a missing link degrades to plain text instead of printing "undefined"', () => {
    const blocks = caseCreatedBlocks({
      title: 'SO-070426-Malware',
      caseId: 'c',
      alertCount: 1,
      slackUserId: 'U',
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain('SO-070426-Malware');
    expect(text).not.toContain('undefined');
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

  test('no link still names the case', () => {
    const text = JSON.stringify(
      alertAddedBlocks({ caseId: 'case-1', alertId: 'a', ruleName: 'R', slackUserId: 'U' })
    );
    expect(text).toContain('case-1');
    expect(text).not.toContain('undefined');
  });
});

describe('newCaseBlocks', () => {
  test('links the title and reports who created it', () => {
    const text = JSON.stringify(
      newCaseBlocks({
        title: 'SO-070426-Malware',
        caseId: 'case-1',
        spaceName: 'Security Operations',
        link: 'https://x/y',
        createdBy: 'jsmith',
      })
    );
    expect(text).toContain('<https://x/y|SO-070426-Malware>');
    expect(text).toContain('jsmith');
  });

  test('an unknown creator is labelled rather than left blank', () => {
    const text = JSON.stringify(
      newCaseBlocks({ title: 'T', caseId: 'c', spaceName: 's', link: 'https://x' })
    );
    expect(text).toContain('unknown');
  });
});