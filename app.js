'use strict';

const { App } = require('@slack/bolt');
const config = require('./config');
const { UserStore, StateStore } = require('./src/store');

const registerStart = require('./src/commands/start');
const registerCase = require('./src/commands/case');
const registerAddAlert = require('./src/commands/add_alert');
const registerStats = require('./src/commands/stats');
const { startWatchers } = require('./src/watchers');

/** Fail fast if required configs are missing */
function requireConfig() {
  const missing = [];
  if (!config.slack.botToken) missing.push('SLACK_BOT_TOKEN');
  if (!config.slack.signingSecret) missing.push('SLACK_SIGNING_SECRET');
  if (config.slack.socketMode && !config.slack.appToken) missing.push('SLACK_APP_TOKEN (Socket Mode)');
  if (!config.elastic.kibanaUrl) missing.push('KIBANA_URL');
  if (!config.elastic.esUrl) missing.push('ELASTICSEARCH_URL');
  if (missing.length) {
    console.error('Missing required configuration:\n  - ' + missing.join('\n  - '));
    console.error('\nCopy .env.example to .env and fill it in.');
    process.exit(1);
  }
}

async function main() {
  requireConfig();

  if (!config.security.encryptionKey) {
    console.warn(
      '[security] ELASTIBOT_SECRET_KEY is not set - analyst API keys will be stored ' +
        'UNENCRYPTED. Set it in .env for at-rest encryption.'
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

  // Register slash commands and interactive handlers
  registerStart(app, ctx);
  registerCase(app, ctx);
  registerAddAlert(app, ctx);
  registerStats(app, ctx);

  // Surface unhandled errors instead of crashing on a single bad event
  app.error(async (error) => {
    console.error('[bolt] uncaught error:', error);
  });

  const port = config.slack.port;
  await app.start(config.slack.socketMode ? undefined : port);
  console.log(
    `Elastibot is running (${config.slack.socketMode ? 'Socket Mode' : `HTTP :${port}`}).`
  );

  const stopWatchers = startWatchers(app, state);

  // Graceful shutdown
  const shutdown = async (sig) => {
    console.log(`\n${sig} received — shutting down.`);
    stopWatchers();
    try {
      await app.stop();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});