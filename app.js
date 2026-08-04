'use strict';

const { App } = require('@slack/bolt');
const config = require('./config');
const { UserStore, StateStore } = require('./src/store');
const { logger } = require('./src/util/logger');
const { registerProcessHandlers, registerBoltErrorHandler } = require('./src/util/errorHandler');
const createRegistrar = require('./src/slack/registrar');

const registerStart = require('./src/commands/start');
const registerCase = require('./src/commands/case');
const registerAddAlert = require('./src/commands/add_alert');
const registerStats = require('./src/commands/stats');
const { startWatchers } = require('./src/watchers');

const log = logger.child({ scope: 'app' });

/** Fail fast if required configs are missing */
function requireConfig() {
  const missing = [];
  if (!config.slack.botToken) missing.push('SLACK_BOT_TOKEN');
  if (!config.slack.signingSecret) missing.push('SLACK_SIGNING_SECRET');
  if (config.slack.socketMode && !config.slack.appToken) missing.push('SLACK_APP_TOKEN (Socket Mode)');
  if (!config.elastic.kibanaUrl) missing.push('KIBANA_URL');
  if (!config.elastic.esUrl) missing.push('ELASTICSEARCH_URL');
  if (missing.length) {
    log.fatal('missing required configuration', { missing });
    log.fatal('copy .env.example to .env and fill it in');
    process.exit(1);
  }
}

async function main() {
  requireConfig();

  if (!config.security.encryptionKey) {
    log.warn(
      'ELASTIBOT_SECRET_KEY is not set - analyst API keys will be stored UNENCRYPTED',
      { scope: 'security', remedy: 'set ELASTIBOT_SECRET_KEY in .env for at-rest encryption' }
    );
  }

  // Shared state passed to command handlers
  const ctx = {
    users: new UserStore({
      filePath: config.security.userStorePath,
      encryptionKey: config.security.encryptionKey,
    }),
  };
  const state = new StateStore({ filePath: config.security.statePath });

  const app = new App({
    token: config.slack.botToken,
    signingSecret: config.slack.signingSecret,
    socketMode: config.slack.socketMode,
    appToken: config.slack.appToken,
  });

  // Every command/action/view goes through the registrar, which owns ack,
  // the "have you run /start" check, logging and error translation
  const reg = createRegistrar(app, ctx);
  registerStart(reg);
  registerCase(reg);
  registerAddAlert(reg);
  registerStats(reg);

  // Surface unhandled errors instead of crashing on a single bad event
  registerBoltErrorHandler(app);

  const port = config.slack.port;
  await app.start(config.slack.socketMode ? undefined : port);
  log.info('elastibot started', {
    mode: config.slack.socketMode ? 'socket' : 'http',
    port: config.slack.socketMode ? undefined : port,
    logLevel: logger.settings.level,
  });

  const stopWatchers = startWatchers(app, state);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal: sig });
    stopWatchers();
    try {
      await app.stop();
    } catch (err) {
      log.warn('error while stopping bolt', { err });
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Last line of defence: log anything that escapes everything above
  registerProcessHandlers({ onFatal: () => stopWatchers() });
}

main().catch((err) => {
  log.fatal('fatal startup error', { err });
  process.exit(1);
});