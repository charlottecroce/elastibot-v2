'use strict';

// The inter-post delay is a Slack rate-limit courtesy, not behaviour under test
jest.mock('../src/util/sleep', () => ({ sleep: jest.fn().mockResolvedValue(undefined) }));

const { pollCases } = require('../src/watchers/cases');
const { STATE_KEYS } = require('../src/constants');
const config = require('../config');

/*
 * The case watcher's whole job is a cursor, and a cursor has
 * exactly two ways to be wrong: advance it when a post failed and the case is
 * lost forever, or fail to advance it and the channel gets the same case every
 * minute. Both are covered below
 */

const T = (min) => new Date(Date.UTC(2026, 6, 30, 12, min)).toISOString();

const kase = (id, min, over = {}) => ({
  id,
  title: `Case ${id}`,
  created_at: T(min),
  owner: 'securitySolution',
  created_by: { username: 'jsmith' },
  ...over,
});

/** A state store backed by a plain object, so assertions can read the cursor */
function fakeState(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: jest.fn((key, fallback) => (key in data ? data[key] : fallback)),
    set: jest.fn((key, value) => { data[key] = value; }),
  };
}

function deps(over = {}) {
  return {
    slack: { chat: { postMessage: jest.fn().mockResolvedValue({ ts: '1' }) } },
    state: fakeState(),
    elastic: { findRecentCases: jest.fn().mockResolvedValue([]) },
    spaces: { getName: jest.fn().mockResolvedValue('Security Operations') },
    channelFor: jest.fn().mockReturnValue('C123'),
    ...over,
  };
}

let originalSpaces;
let originalPerPage;

beforeEach(() => {
  originalSpaces = config.watchers.cases.spaces;
  originalPerPage = config.watchers.cases.perPage;
  config.watchers.cases.spaces = ['soc'];
  config.watchers.cases.perPage = 25;
});

afterEach(() => {
  config.watchers.cases.spaces = originalSpaces;
  config.watchers.cases.perPage = originalPerPage;
});

describe('pollCases', () => {
  test('a space with no routed channel is skipped without querying Kibana', async () => {
    const d = deps({ channelFor: jest.fn().mockReturnValue('') });
    const result = await pollCases(d);

    expect(d.elastic.findRecentCases).not.toHaveBeenCalled();
    expect(result).toMatchObject({ posted: 0, skipped: 1, failed: 0 });
  });

  test('the first run sets the cursor to the newest case and backfills nothing', async () => {
    // Cases come back newest-first. Posting the whole page on first boot would
    // dump a month of history into the channel
    const d = deps();
    d.elastic.findRecentCases.mockResolvedValue([kase('c3', 30), kase('c2', 20), kase('c1', 10)]);

    const result = await pollCases(d);

    expect(d.slack.chat.postMessage).not.toHaveBeenCalled();
    expect(result.posted).toBe(0);
    expect(d.state.data[STATE_KEYS.CASES_LAST_TS]).toEqual({ soc: T(30) });
  });

  test('the first run against an empty space still sets a cursor', async () => {
    const d = deps();
    await pollCases(d);
    expect(d.state.set).toHaveBeenCalled();
    expect(d.state.data[STATE_KEYS.CASES_LAST_TS].soc).toEqual(expect.any(String));
  });

  test('only cases newer than the cursor are posted, oldest first', async () => {
    const d = deps({ state: fakeState({ [STATE_KEYS.CASES_LAST_TS]: { soc: T(10) } }) });
    d.elastic.findRecentCases.mockResolvedValue([kase('c3', 30), kase('c2', 20), kase('c1', 10)]);

    const result = await pollCases(d);

    expect(result.posted).toBe(2);
    const titles = d.slack.chat.postMessage.mock.calls.map((c) => c[0].text);
    expect(titles).toEqual(['New case: Case c2', 'New case: Case c3']); // chronological
    expect(d.state.data[STATE_KEYS.CASES_LAST_TS]).toEqual({ soc: T(30) });
  });

  test('nothing new leaves the cursor and Slack alone', async () => {
    const d = deps({ state: fakeState({ [STATE_KEYS.CASES_LAST_TS]: { soc: T(30) } }) });
    d.elastic.findRecentCases.mockResolvedValue([kase('c3', 30)]);

    const result = await pollCases(d);

    expect(result.posted).toBe(0);
    expect(d.slack.chat.postMessage).not.toHaveBeenCalled();
    expect(d.state.set).not.toHaveBeenCalled(); // no pointless write every minute
  });

  test('a failed query does not advance the cursor', async () => {
    // Advancing here would skip every case created during the outage
    const d = deps({ state: fakeState({ [STATE_KEYS.CASES_LAST_TS]: { soc: T(10) } }) });
    d.elastic.findRecentCases.mockRejectedValue(new Error('kibana down'));

    await expect(pollCases(d)).resolves.toMatchObject({ posted: 0 });
    expect(d.state.data[STATE_KEYS.CASES_LAST_TS]).toEqual({ soc: T(10) });
  });

  test('a failed post is counted and the tick continues', async () => {
    const d = deps({ state: fakeState({ [STATE_KEYS.CASES_LAST_TS]: { soc: T(10) } }) });
    d.elastic.findRecentCases.mockResolvedValue([kase('c2', 20), kase('c3', 30)]);
    d.slack.chat.postMessage
      .mockRejectedValueOnce(new Error('channel_not_found'))
      .mockResolvedValueOnce({ ts: '1' });

    const result = await pollCases(d);

    expect(result).toMatchObject({ posted: 1, failed: 1 });
  });

  test('each space keeps its own cursor', async () => {
    config.watchers.cases.spaces = ['soc', 'obs'];
    const d = deps({ state: fakeState({ [STATE_KEYS.CASES_LAST_TS]: { soc: T(10) } }) });
    d.elastic.findRecentCases.mockImplementation(async (spaceId) =>
      spaceId === 'soc' ? [kase('c2', 20)] : [kase('o1', 40)]
    );

    await pollCases(d);

    const cursors = d.state.data[STATE_KEYS.CASES_LAST_TS];
    expect(cursors.soc).toBe(T(20));
    expect(cursors.obs).toBe(T(40)); // obs had no cursor, so it starts from newest
    expect(d.spaces.getName).toHaveBeenCalledWith('soc', d.elastic);
  });
});