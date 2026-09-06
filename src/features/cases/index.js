'use strict';

const config = require('../../../config');
const featureConfig = require('./config');
const { LEGACY_ACTIONS } = require('./constants');
const { getIncidentStore, closeIncidentStore } = require('./incidentStore');
const { channelFor } = require('./channels');
const { getServiceClient } = require('../../core/elastic');
const { casesEndpoints } = require('./elastic');
const registerCase = require('./commands/case');
const registerAddAlert = require('./commands/add_alert');
const { pollAlerts } = require('./watchers/alerts');
const { pollCases } = require('./watchers/cases');
const { logger } = require('../../core/util/logger');

/*
 * Cases: /case, /add_alert, the incident pipeline and the two watchers.
 *
 * This is the feature that proves the contract is real. It has commands,
 * actions, persistent state, block kits and background work, and every one of
 * those had to be expressible in the descriptor without a special case in the
 * loader. It is enabled by default because it is what the base ships as; that is
 * a default, not an architecture.
 */

const log = logger.child({ scope: 'feature:cases' });

/** A runner tick's dependencies, assembled once per tick */
function watcherDeps(ctx) {
  const client = getServiceClient();
  return {
    slack: ctx.slack,
    state: ctx.state,
    // The alert watcher merges into and updates incidents it posted on earlier
    // ticks, so it needs the same store the button handlers claim against
    incidents: ctx.incidents,
    spaces: ctx.spaces,
    elastic: casesEndpoints(client),
    channelFor,
  };
}

/*
 * Both pollers refuse to run without a service key rather than throwing every
 * tick. startWatchers used to return a no-op runner for this; a guard inside the
 * tick is the equivalent now that the loader owns the runners, and it has the
 * advantage of picking the key up if it is rotated in without a restart.
 */
function guarded(name, poll) {
  let warned = false;
  return async (ctx) => {
    if (!getServiceClient()) {
      if (!warned) {
        warned = true;
        log.warn('ELASTIC_SERVICE_API_KEY not set - the cases watchers cannot run', {
          watcher: name,
          remedy: 'set ELASTIC_SERVICE_API_KEY, or WATCHERS_ENABLED=false to silence this',
        });
      }
      return;
    }
    await poll(watcherDeps(ctx));
  };
}

/*
 * Two watchers, not one tick that does both.
 *
 * THIS IS A BEHAVIOUR CHANGE and it is the only one in the migration. Before,
 * one runner ran pollAlerts then pollCases strictly in sequence; now they have
 * separate runners and can overlap. That is safe - they write different
 * StateStore keys and the store is write-through - and it is right, because they
 * poll independent things with independent cursors and independent enable flags,
 * and the sequencing was incidental rather than designed.
 *
 * What it changes in practice: WATCH_POST_DELAY_MS spaces posts within a poller
 * rather than across both, so a simultaneous alert burst and case sweep can post
 * roughly twice as fast as before. At the 300ms default that is still well
 * inside Slack's limit. If you would rather have the old behaviour back, collapse
 * these into one entry whose tick awaits both in order.
 */
const watchers = [];
if (config.watchers.enabled && config.watchers.alerts.enabled) {
  watchers.push({
    name: 'alerts',
    intervalMs: config.watchers.pollIntervalMs,
    jitterRatio: config.watchers.jitterRatio,
    tick: guarded('alerts', pollAlerts),
  });
}
if (config.watchers.enabled && config.watchers.cases.enabled) {
  watchers.push({
    name: 'cases',
    intervalMs: config.watchers.pollIntervalMs,
    jitterRatio: config.watchers.jitterRatio,
    tick: guarded('cases', pollCases),
  });
}

module.exports = {
  name: 'cases',

  enabled: (cfg) => cfg.features.cases.enabled,

  config: featureConfig,

  /*
   * The old action ids, still live in every incident message posted before this
   * deploy. Registered alongside the namespaced ones for one release; listing
   * them here is what exempts them from the loader's namespace assertion.
   * See ./constants.js for when to delete this.
   */
  legacyActionIds: Object.values(LEGACY_ACTIONS),

  register(reg, ctx) {
    /*
     * The incident store is this feature's, but every handler and watcher
     * reaches it as ctx.incidents - so it is attached to the context the loader
     * handed us, here, before anything can look for it. Core's createContext no
     * longer builds one: it has no idea what an incident is.
     */
    ctx.incidents = getIncidentStore();

    registerCase(reg, ctx);
    registerAddAlert(reg, ctx);
  },

  watchers,

  /**
   * Flush the incident store. Core's ctx.close() no longer does it, and a claim
   * or a messageTs that is not on disk when the process dies is one that never
   * existed - the next boot would offer a second green button for a burst that
   * already has a case.
   */
  close() {
    closeIncidentStore();
  },
};