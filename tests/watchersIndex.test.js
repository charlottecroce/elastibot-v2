'use strict';

jest.mock('../src/elastic', () => ({ getServiceClient: jest.fn() }));
jest.mock('../src/watchers/alerts', () => ({ pollAlerts: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/watchers/cases', () => ({ pollCases: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/watchers/runner', () => ({ createRunner: jest.fn(() => ({ stop: jest.fn(), isRunning: () => true })) }));

const { startWatchers, channelFor } = require('../src/watchers');
const { getServiceClient } = require('../src/elastic');
const { pollAlerts } = require('../src/watchers/alerts');
const { pollCases } = require('../src/watchers/cases');
const { createRunner } = require('../src/watchers/runner');
const config = require('../config');

/*
 * The two things worth pinning down here are the routing
 * fallback (a space with no explicit channel must still land somewhere) and the
 * refusal to start: startWatchers has three separate reasons to return a no-op
 * runner, and a bug in any of them means the bot boots, looks healthy, and
 * silently posts nothing all night
 */

const app = { client: { chat: {} } };
const ctx = { state: {}, incidents: {}, spaces: {} };

let saved;

beforeEach(() => {
  saved = {
    enabled: config.watchers.enabled,
    routing: config.watchers.channelRouting,
    defaultChannel: config.watchers.defaultChannel,
    alerts: config.watchers.alerts.enabled,
    cases: config.watchers.cases.enabled,
  };
  config.watchers.enabled = true;
  config.watchers.channelRouting = {};
  config.watchers.defaultChannel = 'C_DEFAULT';
  getServiceClient.mockReturnValue({ findRecentCases: jest.fn() });
});

afterEach(() => {
  config.watchers.enabled = saved.enabled;
  config.watchers.channelRouting = saved.routing;
  config.watchers.defaultChannel = saved.defaultChannel;
  config.watchers.alerts.enabled = saved.alerts;
  config.watchers.cases.enabled = saved.cases;
});

describe('channelFor', () => {
  test('an explicit route wins over the default', () => {
    config.watchers.channelRouting = { soc: 'C_SOC' };
    expect(channelFor('soc')).toBe('C_SOC');
  });

  test('an unrouted space falls back to the default channel', () => {
    config.watchers.channelRouting = { soc: 'C_SOC' };
    expect(channelFor('obs')).toBe('C_DEFAULT');
  });

  test('with neither configured the space resolves to no channel, not undefined', () => {
    // The watchers treat '' as "skip"; undefined would read as a truthy-check bug
    config.watchers.defaultChannel = '';
    expect(channelFor('obs')).toBe('');
  });
});

describe('startWatchers', () => {
  test('returns a no-op runner when watchers are disabled', () => {
    config.watchers.enabled = false;
    const runner = startWatchers(app, ctx);

    expect(createRunner).not.toHaveBeenCalled();
    expect(runner.isRunning()).toBe(false);
  });

  test('returns a no-op runner when there is no service API key', async () => {
    // The shape has to match a real runner so app.js never null-checks it
    getServiceClient.mockReturnValue(null);
    const runner = startWatchers(app, ctx);

    expect(createRunner).not.toHaveBeenCalled();
    await expect(runner.stop()).resolves.toBeUndefined();
  });

  test('starts with no routing configured at all - it warns rather than refusing', () => {
    // An operator may be routing per-space later; refusing to boot would be worse
    config.watchers.defaultChannel = '';
    startWatchers(app, ctx);
    expect(createRunner).toHaveBeenCalled();
  });

  test('the tick runs both pollers and hands them the shared incident store', async () => {
    config.watchers.alerts.enabled = true;
    config.watchers.cases.enabled = true;

    startWatchers(app, ctx);
    const { tick } = createRunner.mock.calls[0][0];
    await tick();

    expect(pollAlerts).toHaveBeenCalledTimes(1);
    expect(pollCases).toHaveBeenCalledTimes(1);
    // The button handlers claim against ctx.incidents; the watcher must merge
    // into that same store or it posts a second message for the same burst
    expect(pollAlerts.mock.calls[0][0].incidents).toBe(ctx.incidents);
  });

  test('each poller can be disabled independently', async () => {
    config.watchers.alerts.enabled = false;
    config.watchers.cases.enabled = true;

    startWatchers(app, ctx);
    await createRunner.mock.calls[0][0].tick();

    expect(pollAlerts).not.toHaveBeenCalled();
    expect(pollCases).toHaveBeenCalledTimes(1);
  });
});