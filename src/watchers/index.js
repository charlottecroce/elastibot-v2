'use strict';

const config = require('../../config');
const { getServiceClient } = require('../elastic');
const { pollAlerts } = require('./alerts');
const { pollCases } = require('./cases');
const { createRunner } = require('./runner');
const { logger } = require('../util/logger');

/*
 * Watcher wiring.
 *
 * Decide whether the watchers should run, assemble their dependencies, and hand
 * a tick to the runner. The polling logic lives in alerts.js and cases.js, the
 * loop lives in runner.js
 *
 * Routing: config.watchers.channelRouting[spaceId] || config.watchers.defaultChannel
 */

const log = logger.child({ scope: 'watchers' });

function channelFor(spaceId) {
  return config.watchers.channelRouting[spaceId] || config.watchers.defaultChannel || '';
}

/** A runner-shaped no-op, for the cases where we never start */
const noopRunner = () => ({ stop: async () => {}, isRunning: () => false });

/**
 * Start the polling loop.
 *
 * @param {object} app  Bolt app
 * @param {object} ctx  application context ({ state, incidents, spaces })
 * @returns {{stop: function(): Promise<void>, isRunning: function(): boolean}}
 */
function startWatchers(app, ctx) {
  if (!config.watchers.enabled) {
    log.info('watchers disabled via config');
    return noopRunner();
  }

  const elastic = getServiceClient();
  if (!elastic) {
    log.warn('ELASTIC_SERVICE_API_KEY not set - watchers cannot run', {
      remedy: 'set ELASTIC_SERVICE_API_KEY in .env, or WATCHERS_ENABLED=false to silence this',
    });
    return noopRunner();
  }

  if (!config.watchers.defaultChannel && Object.keys(config.watchers.channelRouting).length === 0) {
    log.warn('no channel routing configured - nothing will be posted', {
      remedy: 'set DEFAULT_CHANNEL or fill in config.watchers.channelRouting',
    });
  }

  const deps = {
    slack: app.client,
    state: ctx.state,
    // The alert watcher merges into and updates incidents it posted on earlier
    // ticks, so it needs the same store the button handlers claim against
    incidents: ctx.incidents,
    spaces: ctx.spaces,
    elastic,
    channelFor,
  };

  const tick = async () => {
    if (config.watchers.alerts.enabled) await pollAlerts(deps);
    if (config.watchers.cases.enabled) await pollCases(deps);
  };

  const runner = createRunner({
    tick,
    name: 'watchers',
    intervalMs: config.watchers.pollIntervalMs,
    jitterRatio: config.watchers.jitterRatio,
  });

  log.info('watchers started', {
    pollIntervalMs: config.watchers.pollIntervalMs,
    alerts: config.watchers.alerts.enabled,
    cases: config.watchers.cases.enabled,
    caseSpaces: config.watchers.cases.spaces,
    casePerPage: config.watchers.cases.perPage,
    incidentIdleMs: config.incidents.idleMs,
  });

  return runner;
}

module.exports = { startWatchers, channelFor };