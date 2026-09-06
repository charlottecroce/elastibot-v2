'use strict';

const featureConfig = require('./config');
const registerStats = require('./commands/stats');

/*
 * /stats - an aggregate view of the alerts index.
 *
 * The smallest of the three features and the one that shows the floor of the
 * contract: one command, no actions, no watchers, no state. Everything optional
 * in the descriptor is genuinely left out rather than stubbed.
 */

module.exports = {
  name: 'stats',

  enabled: (config) => config.features.stats.enabled,

  config: featureConfig,

  register(reg, ctx) {
    registerStats(reg, ctx);
  },
};