'use strict';

/*
 * Centralized error handling.
 *
 *   handleHandlerError   - a slash command / button / modal threw
 *   registerBoltErrorHandler - Bolt caught something outside our handlers
 *   registerProcessHandlers  - an unhandled rejection or uncaught exception
 *
 * The policy: log with full detail at the right level, then tell the analyst
 * only what they can act on. Never let the reply path throw a second error on
 * top of the first
 */

const { logger: rootLogger } = require('./logger');
const { isUserFacing, toUserMessage } = require('./errors');

/**
 * Reply without risking a second failure. If Slack itself is the thing that's
 * broken, we log that and move on rather than unwinding into Bolt
 */
async function safeReply(reply, text, log) {
  if (!reply || typeof reply.ephemeral !== 'function') return;
  try {
    await reply.ephemeral(text);
  } catch (replyErr) {
    (log || rootLogger).error('failed to deliver error message to Slack', { err: replyErr });
  }
}

/**
 * Handle a failure inside a Slack interaction handler
 *
 * @param {Error} err
 * @param {object} opts
 * @param {object} opts.log      scoped logger (already carries traceId)
 * @param {object} opts.reply    { ephemeral(text) }
 * @param {string} opts.traceId  short id echoed to the user for unexpected errors
 * @param {string|function} [opts.userErrorSuffix] extra text appended to user-facing errors
 */
async function handleHandlerError(err, { log = rootLogger, reply, traceId, userErrorSuffix } = {}) {
  if (isUserFacing(err)) {
    // Expected: bad input, missing alert, rejected key. Not a defect - info level
    log.info('request rejected', { reason: err.message, status: err.status, code: err.code });

    let text = `:x: ${err.message}`;
    const suffix = typeof userErrorSuffix === 'function' ? userErrorSuffix(err) : userErrorSuffix;
    if (suffix) text += `\n\n${suffix}`;
    await safeReply(reply, text, log);
    return;
  }

  // Unexpected: a defect or a dependency failure. Full detail to the log only
  log.error('handler failed', { err });
  await safeReply(reply, `:x: ${toUserMessage(err, traceId)}`, log);
}

/**
 * Bolt's own catch-all, for anything that escapes our wrappers (middleware,
 * deserialization) 
 */
function registerBoltErrorHandler(app, log = rootLogger.child({ scope: 'bolt' })) {
  app.error(async (error) => {
    log.error('unhandled bolt error', { err: error });
  });
}

/**
 * Process-level safety net.
 *
 * An unhandled rejection is logged and survived - one bad watcher tick or a
 * dropped promise shouldn't take the bot down mid-shift. An uncaught exception
 * means state is no longer trustworthy, so we log, run the shutdown hook, and
 * exit until a supervisor can restart us
 *
 * @param {object} opts
 * @param {function} [opts.onFatal] async cleanup before exit
 * @param {number}   [opts.exitTimeoutMs] how long cleanup gets before a hard exit
 */
function registerProcessHandlers({
  log = rootLogger.child({ scope: 'process' }),
  onFatal,
  exitTimeoutMs = 5000,
} = {}) {
  let exiting = false;

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log.error('unhandled promise rejection', { err });
  });

  process.on('uncaughtException', (err) => {
    log.fatal('uncaught exception - shutting down', { err });
    if (exiting) return;
    exiting = true;

    const hardExit = setTimeout(() => process.exit(1), exitTimeoutMs);
    hardExit.unref?.();

    Promise.resolve(onFatal?.())
      .catch((cleanupErr) => log.error('cleanup failed during fatal exit', { err: cleanupErr }))
      .finally(() => process.exit(1));
  });

  process.on('warning', (warning) => {
    log.warn('node warning', { err: warning });
  });
}

module.exports = {
  safeReply,
  handleHandlerError,
  registerBoltErrorHandler,
  registerProcessHandlers,
};