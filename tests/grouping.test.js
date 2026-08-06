'use strict';

const { groupAlerts, makeGroup, isMachineUser, bareUser } = require('../src/grouping');

/*
 * Grouping decides how many messages hit the channel and how many alerts land
 * in one case.
 *
 * Two things it has to get right:
 *   - a service account must not split one analyst's incident into three
 *     messages (the merge)
 *   - two analysts on a shared host must not end up in one case (the limit)
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

/** ids of each group, sorted, so assertions don't depend on group order */
function idsOf(groups) {
  return groups.map((g) => g.alerts.map((a) => a.id).sort()).sort((a, b) => a[0] < b[0] ? -1 : 1);
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

  test('different host or space never merge', () => {
    const groups = groupAlerts(
      [
        alert('a'),
        alert('b', { hostName: 'web-02' }),
        alert('d', { spaceId: 'soc' }),
      ],
      HOUR
    );
    expect(groups).toHaveLength(3);
  });

  test('an alert with no host is uncorrelatable and stays a singleton', () => {
    // Host is the axis grouping hangs on now, so losing it is what isolates an
    // alert. Losing only the user does not - see the machine-identity block
    const groups = groupAlerts(
      [
        alert('a', { hostName: undefined }),
        alert('b', { hostName: undefined, userName: undefined }),
      ],
      HOUR
    );
    expect(groups).toHaveLength(2);
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

/*
 * The reason this pass exists: an analyst session on one host fires alerts under
 * their own name AND under whatever service account ran the command. Those used
 * to be separate messages with separate green buttons, which is how the same
 * incident ended up in two cases
 */
describe('machine identities', () => {
  test('recognises service, system and computer accounts', () => {
    expect(isMachineUser('SYSTEM')).toBe(true);
    expect(isMachineUser('NT AUTHORITY\\SYSTEM')).toBe(true);
    expect(isMachineUser('LOCAL SERVICE')).toBe(true);
    expect(isMachineUser('CORP\\svc_backup')).toBe(true);
    expect(isMachineUser('WEB-01$')).toBe(true); // AD computer account
    expect(isMachineUser('root')).toBe(true);
    expect(isMachineUser('_apt')).toBe(true);
    expect(isMachineUser(undefined)).toBe(true); // absent says nothing about who
  });

  test('a human account is not a machine one', () => {
    expect(isMachineUser('jsmith')).toBe(false);
    expect(isMachineUser('CORP\\jsmith')).toBe(false);
  });

  test('the domain prefix is stripped before matching', () => {
    expect(bareUser('NT AUTHORITY\\SYSTEM')).toBe('SYSTEM');
    expect(bareUser('CORP/jsmith')).toBe('jsmith');
    expect(bareUser('jsmith')).toBe('jsmith');
    expect(bareUser(undefined)).toBeNull();
  });

  test('machine identities fold into the human incident on the same host', () => {
    const groups = groupAlerts(
      [
        alert('u1', { timestamp: at(0) }),
        alert('s1', { userName: 'SYSTEM', timestamp: at(1) }),
        alert('s2', { userName: 'NT AUTHORITY\\SYSTEM', timestamp: at(2) }),
        alert('u2', { timestamp: at(3) }),
        alert('v1', { userName: 'svc_backup', timestamp: at(4) }),
        alert('n1', { userName: undefined, timestamp: at(5) }),
      ],
      HOUR
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(6);
    // The human name labels the incident even though SYSTEM fired more of it
    expect(groups[0].userName).toBe('jsmith');
    expect(groups[0].machineOnly).toBe(false);
  });

  test('the same account under two spellings counts once', () => {
    // userNames is what incidents.findMatch compares across polls, so a
    // duplicate here would look like two users and split the incident
    const g = makeGroup([
      alert('a', { userName: 'SYSTEM' }),
      alert('b', { userName: 'NT AUTHORITY\\SYSTEM' }),
    ]);
    expect(g.userNames).toEqual(['SYSTEM']);
  });

  test('two humans on a shared host stay separate', () => {
    // The limit on the merge. Collapsing these would put one analyst's alerts
    // in the other's case
    const groups = groupAlerts(
      [
        alert('j1', { timestamp: at(0) }),
        alert('a1', { userName: 'adoe', timestamp: at(5) }),
      ],
      HOUR
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.userName).sort()).toEqual(['adoe', 'jsmith']);
  });

  test('a machine cluster outside the window is not dragged in', () => {
    const groups = groupAlerts(
      [
        alert('u1', { timestamp: at(0) }),
        alert('s1', { userName: 'SYSTEM', timestamp: at(400) }),
      ],
      HOUR
    );
    expect(idsOf(groups)).toEqual([['s1'], ['u1']]);
  });

  test('a host with only service accounts collapses to one incident', () => {
    const groups = groupAlerts(
      [
        alert('s1', { userName: 'SYSTEM', timestamp: at(0) }),
        alert('s2', { userName: 'svc_backup', timestamp: at(5) }),
        alert('s3', { userName: undefined, timestamp: at(9) }),
      ],
      HOUR
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].machineOnly).toBe(true);
  });

  test('machine identities never cross hosts', () => {
    const groups = groupAlerts(
      [
        alert('u1', { timestamp: at(0) }),
        alert('h1', { hostName: 'web-02', userName: 'SYSTEM', timestamp: at(1) }),
      ],
      HOUR
    );
    expect(idsOf(groups)).toEqual([['h1'], ['u1']]);
  });

  test('mergeMachineUsers off restores the old user+host split', () => {
    const groups = groupAlerts(
      [
        alert('u1', { timestamp: at(0) }),
        alert('s1', { userName: 'SYSTEM', timestamp: at(1) }),
      ],
      HOUR,
      { mergeMachineUsers: false }
    );
    expect(idsOf(groups)).toEqual([['s1'], ['u1']]);
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

  test('a group with no human identity reports machineOnly', () => {
    const g = makeGroup([alert('a', { userName: 'SYSTEM' })]);
    expect(g.machineOnly).toBe(true);
    expect(g.userName).toBe('SYSTEM'); // still labelled, just not by a human
  });
});