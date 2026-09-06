'use strict';

const featureConfig = require('./config');
const registerCommands = require('./commands/example');

/*
 * A working feature that does nothing.
 *
 * Copy this folder, rename it, add one line to src/features/registry.js, and you
 * have a feature. It is skipped by the loader as it stands because it is not in
 * that registry - the underscore prefix is only a convention for the reader.
 *
 * The four things worth copying carefully:
 *
 *   1. config.js takes `s` as an argument and requires nothing from config/.
 *   2. Action ids are prefixed with the feature name.
 *   3. Nothing here requires another feature. If you need something a different
 *      feature has, promote it to core - and only once there is a second
 *      consumer for it, not in anticipation of one.
 *   4. register() may throw. The bot will boot without you and log why. Do not
 *      try to be clever about swallowing your own startup errors; let them out.
 */

module.exports = {
  /** Must match the `name` in src/features/registry.js */
  name: 'example',

  /**
   * Whether to load at all. `config.features.example.enabled` is resolved by the
   * loader for every registered feature, from features.example.enabled in
   * elastibot.yml or FEATURE_EXAMPLE_ENABLED.
   */
  enabled: (config) => config.features.example.enabled,

  /** { defaults(s), validate(cfg, { errors, warnings }) } */
  config: featureConfig,

  /**
   * Commands, actions and modals. Runs once at boot.
   *
   * @param {object} reg the registrar - reg.command / reg.action / reg.view,
   *   with the same handler args and options as everywhere else
   * @param {object} ctx the application context: users, state, incidents,
   *   spaces, log
   */
  register(reg, ctx) {
    registerCommands(reg, ctx);
  },

  /**
   * Background work. One runner per entry, each with its own interval and its
   * own overlap guard.
   *
   * `tick` is called with the application context plus `slack` (the Bolt web
   * client), and only ever after app.start() - a tick that posts needs a live
   * client. A tick that throws is logged, counted and survived.
   */
  watchers: [
    // {
    //   name: 'poll',
    //   intervalMs: 60000,
    //   jitterRatio: 0.1,
    //   async tick({ slack, state, log }) {},
    // },
  ],

  /** Best effort, on shutdown. Never let it throw; the loader logs if it does */
  close() {},
};