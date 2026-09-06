'use strict';

const { App } = require('@slack/bolt');
const config = require('../../config');
const { validateConfig } = require('../../config/validate');
const { createContext } = require('./context');
const { logger } = require('./util/logger');
const { registerProcessHandlers, registerBoltErrorHandler } = require('./util/errorHandler');
const createRegistrar = require('./slack/registrar');
const { registerAll } = require('./commands');
const {
  loadFeatures,
  registerFeatures,
  startFeatureWatchers,
  closeFeatures,
} = require('../features');

/*
 * Bootstrap only.
 *
 *   logging > process handlers > config validation > context > slack app
 *     > core commands > features > watchers > shutdown
 *
 * Two lines changed shape in the move to core-plus-features, and both are in the
 * same place: registerAll(reg) now registers only the commands core owns
 * (/start), and everything else arrives through the feature loader. Nothing else
 * about the order moved, because the reasons for the order did not.
 */

const log = logger.child({ scope: 'app' });

async function main() {
  /*
   * Logging first, so everything below - including the config warnings
   * validateConfig is about to emit - honours the operator's chosen level and
   * format. util/logger has no dependency on config
   *
   * configure() ignores an unrecognised level/format rather than throwing,
   * because validateConfig is the thing that reports those properly - and it
   * needs a working logger to do it
   */
  logger.configure(config.logging);

  // Registered next so it covers everything below. Hooks are collected as the
  // pieces they clean up come into existence
  const fatalHooks = [];
  registerProcessHandlers({
    onFatal: async () => {
      for (const hook of fatalHooks) {
        try {
          await hook();
        } catch {
          /* best effort during a fatal exit */
        }
      }
    },
  });

  /*
   * Throws ConfigError listing everything that's wrong, not just the first -
   * now including every feature's own validate(), so a bad sigma setting and a
   * missing Slack token are still one round of fixes rather than two restarts
   */
  validateConfig(config);

  const ctx = createContext();
  fatalHooks.push(() => ctx.close());

  const app = new App({
    token: config.slack.botToken,
    signingSecret: config.slack.signingSecret,
    socketMode: config.slack.socketMode,
    appToken: config.slack.appToken,
  });

  // The registrar owns ack, the "have you run /start" check, logging and error
  // translation. Unchanged, and deliberately so: features register through it,
  // they do not register around it
  const reg = createRegistrar(app, ctx);

  // Core's own commands. /start is here because an analyst has to be able to
  // connect before any feature has anything to say to them
  registerAll(reg);

  /*
   * Features. A descriptor that fails to load, fails to validate, or throws out
   * of register() is logged and skipped - the bot comes up without it. One
   * broken contribution should not ground the whole bot, and the alternative
   * (letting it throw here) means a typo in a feature nobody has enabled yet
   * takes the SOC's alerting offline
   */
  const { enabled, disabled } = loadFeatures(config);
  const { registered, failed } = registerFeatures(enabled, reg, ctx);

  log.info('features loaded', {
    active: registered.map((f) => f.name),
    disabled: disabled.map((f) => f.name),
    failed: failed.map((f) => f.name),
  });

  fatalHooks.push(() => closeFeatures(registered));

  registerBoltErrorHandler(app);

  // Declared before app.start() so a SIGTERM during startup still takes the
  // graceful path. Same shape as a real runner, so nothing has to null-check it
  let watchers = { stop: async () => {}, isRunning: () => false };
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });

    // Never let a hung dependency keep the process alive forever
    const hardExit = setTimeout(() => {
      log.error('shutdown timed out - exiting hard', { timeoutMs: config.shutdownTimeoutMs });
      process.exit(1);
    }, config.shutdownTimeoutMs);
    hardExit.unref?.();

    try {
      // Watchers first, so the cursor written to disk is final and is not
      // overwritten by a tick that is still finishing. Then the features
      // themselves, then Bolt, then the stores
      await watchers.stop();
      await closeFeatures(registered);
      await app.stop();
      await ctx.close();
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error('error during shutdown', { err });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.start(config.slack.socketMode ? undefined : config.slack.port);
  log.info('elastibot started', {
    mode: config.slack.socketMode ? 'socket' : 'http',
    port: config.slack.socketMode ? undefined : config.slack.port,
    logLevel: logger.settings.level,
    features: registered.map((f) => f.name),
  });

  /*
   * Watchers last, after app.start(), because a tick that posts needs a live
   * Slack client. One runner per contributed watcher rather than one shared
   * tick - see src/features/index.js
   */
  watchers = startFeatureWatchers(registered, ctx, { slack: app.client });
  // Stop polling before flushing the stores, so the cursor written is final
  fatalHooks.unshift(() => watchers.stop());
}

module.exports = { main };