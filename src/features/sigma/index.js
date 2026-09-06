'use strict';

const featureConfig = require('./config');
const registerCommands = require('./commands/sigma');
const session = require('./sigmaSession');

/*
 * /sigma - reconcile the detection rules in a Kibana space against the local
 * Sigma database that `npm run update-sigmaDB` builds.
 *
 * The pilot for the feature contract, and picked for that on purpose: it has a
 * command with subcommands, five actions, its own config namespace, its own
 * storage, its own scripts, and no watchers or persistent Slack state. That is
 * enough surface to prove the descriptor without also having to be right about
 * watchers and long-lived message ids on the first attempt.
 *
 * Note what is NOT here: no wiring, no elastic client, no blocks. The descriptor
 * is a manifest. Everything it names lives in a file next to it, and this file
 * should stay short enough to read in one go - if it starts accumulating logic,
 * that logic belongs in the feature, not in its front door.
 */

module.exports = {
  name: 'sigma',

  /*
   * The loader also honours features.sigma.enabled on its own, but reading it
   * here is what makes the descriptor self-describing: this is the one line to
   * change if the feature ever needs a second condition (a required binary, a
   * paid licence tier) beyond an operator's switch.
   */
  enabled: (config) => config.features.sigma.enabled,

  config: featureConfig,

  register(reg, ctx) {
    registerCommands(reg, ctx);
  },

  watchers: [],

  /*
   * Drop every open pager. These are in-memory result sets keyed by a token in
   * a button payload; on shutdown they are already worthless, and leaving them
   * pinned would keep a few thousand rule objects alive across a slow drain.
   */
  close() {
    session.clear();
  },
};