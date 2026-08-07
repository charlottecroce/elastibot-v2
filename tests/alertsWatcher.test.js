'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// CURSOR_FIELD is the only thing alerts.js needs from the elastic module, and
// requiring the real one pulls in an axios client the watcher never uses here
jest.mock('../src/elastic', () => ({ CURSOR_FIELD: 'kibana.alert.start' }));

const { pollAlerts } = require('../src/watchers/alerts');
const { IncidentStore } = require('../src/incidents');
const { StateStore } = require('../src/store');

/*
 * These are about how many messages reach the channel.
 *
 * The regression they guard: `update-elastibot.sh` used to copy data/ before
 * stopping the bot, so the restored state.json carried a cursor older than what
 * had actually been posted. Elastic then handed the same alerts back and the
 * watcher posted them a second time.
 */

const T0 = '2026-07-30T12:00:00.000Z';
const T1 = '2026-07-30T12:05:00.000Z';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-watcher-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function alert(id, over = {}) {
  return {
    id,
    index: '.internal.alerts-security.alerts-default-000001',
    spaceId: 'default',
    ruleName: 'Malware Detected',
    ruleId: 'rule-a',
    severity: 'high',
    timestamp: T0,
    cursorTimestamp: T0,
    userName: 'jsmith',
    hostName: 'web-01',
    ...over,
  };
}

/** Everything pollAlerts needs, with a real state + incident store on disk */
function deps(alerts, { cursor = '2026-07-30T11:00:00.000Z' } = {}) {
  const state = new StateStore({ filePath: path.join(dir, 'state.json') });
  state.set('alertsLastTs', cursor);

  return {
    slack: {
      chat: {
        postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '1700000000.000100' }),
        update: jest.fn().mockResolvedValue({ ok: true }),
      },
    },
    state,
    incidents: new IncidentStore({
      filePath: path.join(dir, 'incidents.json'),
      idleMs: 8 * 3600000,
      maxLifetimeMs: 24 * 3600000,
      claimTtlMs: 60000,
    }),
    elastic: { getAlertsSince: jest.fn().mockResolvedValue(alerts) },
    spaces: { getName: jest.fn().mockResolvedValue('Security Operations') },
    channelFor: () => 'C1',
  };
}

describe('posting', () => {
  test('a new alert produces exactly one message', async () => {
    const d = deps([alert('a1')]);

    const result = await pollAlerts(d);

    expect(d.slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(result.posted).toBe(1);
  });

  test('a burst on one host is one message, not one per alert', async () => {
    const d = deps([alert('a1'), alert('a2'), alert('a3')]);

    await pollAlerts(d);

    expect(d.slack.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  test('the cursor advances to the newest alert in the batch', async () => {
    const d = deps([alert('a1'), alert('a2', { cursorTimestamp: T1 })]);

    await pollAlerts(d);

    expect(d.state.get('alertsLastTs', null)).toBe(T1);
  });
});

describe('a rewound cursor never posts the same alert twice', () => {
  test('an alert already on a record is dropped when the batch is replayed', async () => {
    const d = deps([alert('a1')]);
    await pollAlerts(d);
    expect(d.slack.chat.postMessage).toHaveBeenCalledTimes(1);

    // What a data/ restore looks like: the cursor goes backwards and Elastic
    // returns the same alert again
    d.state.set('alertsLastTs', '2026-07-30T11:00:00.000Z');
    const result = await pollAlerts(d);

    expect(d.slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(result.posted).toBe(0);
    expect(result.skipped).toBe(1);
  });

  /*
   * findMatch bails on a record with no host, so this alert is invisible to the
   * merge path. Without the id filter in pollAlerts it opened a fresh incident
   * and posted again on every replay
   */
  test('a hostless alert is dropped on replay too', async () => {
    const d = deps([alert('a1', { hostName: undefined })]);
    await pollAlerts(d);

    d.state.set('alertsLastTs', '2026-07-30T11:00:00.000Z');
    await pollAlerts(d);

    expect(d.slack.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  test('a genuinely new alert on the same host updates rather than posts', async () => {
    const d = deps([alert('a1')]);
    await pollAlerts(d);

    d.elastic.getAlertsSince.mockResolvedValue([alert('a2', { cursorTimestamp: T1 })]);
    const result = await pollAlerts(d);

    expect(d.slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(d.slack.chat.update).toHaveBeenCalledTimes(1);
    expect(result.updated).toBe(1);
  });

  test('the cursor still advances when every alert was already posted', async () => {
    const d = deps([alert('a1')]);
    await pollAlerts(d);

    d.state.set('alertsLastTs', '2026-07-30T11:00:00.000Z');
    await pollAlerts(d);

    expect(d.state.get('alertsLastTs', null)).toBe(T0);
  });
});

describe('failure paths', () => {
  test('a failed query holds the cursor rather than skipping alerts', async () => {
    const d = deps([]);
    d.elastic.getAlertsSince.mockRejectedValue(new Error('cluster down'));

    const result = await pollAlerts(d);

    expect(d.state.get('alertsLastTs', null)).toBe('2026-07-30T11:00:00.000Z');
    expect(result.posted).toBe(0);
  });

  test('a failed post leaves no record for the next tick to merge into', async () => {
    const d = deps([alert('a1')]);
    d.slack.chat.postMessage.mockRejectedValue(new Error('channel_not_found'));

    const result = await pollAlerts(d);

    expect(result.failed).toBe(1);
    expect(d.incidents.findByAlertId('a1')).toBeNull();
  });

  test('an unrouted space is counted, not silently ignored', async () => {
    const d = deps([alert('a1')]);
    d.channelFor = () => '';

    const result = await pollAlerts(d);

    expect(result.skipped).toBe(1);
    expect(d.slack.chat.postMessage).not.toHaveBeenCalled();
  });

  test('a batch with no usable cursor timestamp holds the cursor', async () => {
    const d = deps([alert('a1', { cursorTimestamp: undefined })]);

    await pollAlerts(d);

    expect(d.state.get('alertsLastTs', null)).toBe('2026-07-30T11:00:00.000Z');
  });
});