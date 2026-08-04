'use strict';

const {
  groupAlerts,
  makeGroup,
  encodeGroupValue,
  decodeGroupValue,
} = require('../src/grouping');

/*
 * Grouping decides how many messages hit the channel and how many alerts land in one case
 */

const T0 = '2026-07-30T12:00:00.000Z';
const HOUR = 3600000;

/** minimal alert doc */
function alert(id, over = {}) {
  return {
    id,
    index: '.internal.alerts-security.alerts-default-000001',
    spaceId: 'default',
    ruleName: 'Rule A',
    severity: 'low',
    timestamp: T0,
    userName: 'jsmith',
    hostName: 'web-01',
    ...over,
  };
}

/** t0 + n minutes, as ISO */
function at(minutes) {
  return new Date(Date.parse(T0) + minutes * 60000).toISOString();
}

describe('groupAlerts', () => {
  test('same user + host inside the window collapse into one group', () => {
    const groups = groupAlerts(
      [alert('a', { timestamp: at(0) }), alert('b', { timestamp: at(20) }), alert('c', { timestamp: at(50) })],
      HOUR
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].from).toBe(at(0));
    expect(groups[0].to).toBe(at(50));
  });

  test('an alert past the window starts a new group', () => {
    const groups = groupAlerts(
      [alert('a', { timestamp: at(0) }), alert('b', { timestamp: at(61) })],
      HOUR
    );
    expect(groups.map((g) => g.count)).toEqual([1, 1]);
  });

  test('the window is measured from the FIRST alert, not the previous one', () => {
    // 0, 45, 90: the 90 minute alert is inside an hour of the 45 but not the 0
    const groups = groupAlerts(
      [
        alert('a', { timestamp: at(0) }),
        alert('b', { timestamp: at(45) }),
        alert('c', { timestamp: at(90) }),
      ],
      HOUR
    );
    expect(groups.map((g) => g.count).sort()).toEqual([1, 2]);
  });

  test('different host, user or space never merge', () => {
    const groups = groupAlerts(
      [
        alert('a'),
        alert('b', { hostName: 'web-02' }),
        alert('c', { userName: 'adoe' }),
        alert('d', { spaceId: 'soc' }),
      ],
      HOUR
    );
    expect(groups).toHaveLength(4);
  });

  test('alerts without user or host each become their own group', () => {
    const groups = groupAlerts(
      [
        alert('a', { userName: undefined }),
        alert('b', { hostName: undefined }),
        alert('c', { userName: undefined, hostName: undefined }),
      ],
      HOUR
    );
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.count === 1)).toBe(true);
  });

  test('input order does not matter', () => {
    const groups = groupAlerts(
      [alert('c', { timestamp: at(50) }), alert('a', { timestamp: at(0) })],
      HOUR
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].alerts.map((a) => a.id)).toEqual(['a', 'c']);
  });

  test('empty input > no groups', () => {
    expect(groupAlerts([], HOUR)).toEqual([]);
  });
});

describe('makeGroup', () => {
  test('picks the highest severity and the most common rule', () => {
    const g = makeGroup([
      alert('a', { ruleName: 'Rule B', severity: 'low' }),
      alert('b', { ruleName: 'Rule A', severity: 'critical' }),
      alert('c', { ruleName: 'Rule A', severity: 'medium' }),
    ]);
    expect(g.topSeverity).toBe('critical');
    expect(g.representativeRule).toBe('Rule A');
    expect(g.ruleCounts).toEqual({ 'Rule A': 2, 'Rule B': 1 });
  });

  test('unknown severities do not outrank real ones', () => {
    const g = makeGroup([
      alert('a', { severity: undefined }),
      alert('b', { severity: 'low' }),
    ]);
    expect(g.topSeverity).toBe('low');
  });
});

describe('encode / decode button value', () => {
  test('a correlatable group carries query coordinates, not alert ids', () => {
    const g = makeGroup([alert('a', { timestamp: at(0) }), alert('b', { timestamp: at(10) })]);
    const decoded = decodeGroupValue(encodeGroupValue(g));
    expect(decoded).toEqual({
      k: 'g',
      s: 'default',
      u: 'jsmith',
      h: 'web-01',
      f: at(0),
      t: at(10),
    });
  });

  test('an uncorrelatable singleton carries just the alert id', () => {
    const g = makeGroup([alert('lonely', { userName: undefined })]);
    expect(decodeGroupValue(encodeGroupValue(g))).toEqual({ k: 'a', a: 'lonely' });
  });

  test('stays under the 2000 char Slack button limit for a big burst', () => {
    const many = Array.from({ length: 200 }, (_, i) => alert(`alert-${i}`, { timestamp: at(i % 30) }));
    expect(encodeGroupValue(makeGroup(many)).length).toBeLessThan(2000);
  });

  test('a bare alert id decodes as a singleton', () => {
    expect(decodeGroupValue('raw-alert-id')).toEqual({ k: 'a', a: 'raw-alert-id' });
  });

  test('unparseable or unexpected JSON falls back to a singleton', () => {
    expect(decodeGroupValue('{not json')).toEqual({ k: 'a', a: '{not json' });
    expect(decodeGroupValue('{"k":"x"}')).toEqual({ k: 'a', a: '{"k":"x"}' });
  });
});