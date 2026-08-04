'use strict';

const { App } = require('@slack/bolt');
const config = require('./config');
const { validateConfig } = require('./config/validate');
const { createContext } = require('./src/context');
const { logger } = require('./src/util/logger');
const { registerProcessHandlers, registerBoltErrorHandler } = require('./src/util/errorHandler');
const createRegistrar = require('./src/slack/registrar');
const { registerAll } = require('./src/commands');
const { startWatchers } = require('./src/watchers');

/*
 * Bootstrap only.
 *
 *   config validation > context > slack app > commands > watchers > shutdown
 */

const log = logger.child({ scope: 'app' });

async function main() {
  // Throws ConfigError listing everything that's wrong, not just the first
  validateConfig(config);

  const ctx = createContext();

  const app = new App({
    token: config.slack.botToken,
    signingSecret: config.slack.signingSecret,
    socketMode: config.slack.socketMode,
    appToken: config.slack.appToken,
  });

  // The registrar owns ack, the "have you run /start" check, logging and error
  // translation. Command modules are discovered from src/commands/
  const reg = createRegistrar(app, ctx);
  registerAll(reg);

  registerBoltErrorHandler(app);

  await app.start(config.slack.socketMode ? undefined : config.slack.port);
  log.info('elastibot started', {
    mode: config.slack.socketMode ? 'socket' : 'http',
    port: config.slack.socketMode ? undefined : config.slack.port,
    logLevel: logger.settings.level,
  });

  const watchers = startWatchers(app, ctx);

  /*
   * Shutdown
   */
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
      await watchers.stop();
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

  // onFatal still flushes the cursor file, so a crash
  // doesn't cost us the alerts we already posted
  registerProcessHandlers({
    onFatal: async () => {
      await watchers.stop();
      await ctx.close();
    },
  });
}

main().catch((err) => {
  log.fatal('fatal startup error', { err });
  process.exit(1);
});