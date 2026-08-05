'use strict';

const { logger } = require('../util/logger');

/*
 * The polling loop, separated from what gets polled.
 */

const log = logger.child({ scope: 'watcher:runner' });

/**
 * @param {object} opts
 * @param {function} opts.tick        async function to run each interval
 * @param {number} opts.intervalMs
 * @param {number} [opts.jitterRatio] 0-1, fraction of the interval to randomise
 * @param {boolean} [opts.runImmediately]
 * @param {string} [opts.name]
 * @returns {{stop: function(): Promise<void>, isRunning: function(): boolean}}
 */
function createRunner({
  tick,
  intervalMs,
  jitterRatio = 0.1,
  runImmediately = true,
  name = 'runner',
}) {
  let timer = null;
  let inFlight = null;
  let stopped = false;
  let consecutiveFailures = 0;

  const nextDelay = () => {
    const jitter = intervalMs * jitterRatio * (Math.random() * 2 - 1);
    // No floor here on purpose: a runner that quietly ignores its configured
    // interval is worse than a fast one. The sane-minimum check lives in
    // config/validate.js, where an operator can actually see it
    return Math.max(0, Math.round(intervalMs + jitter));
  };

  async function runOnce() {
    if (stopped) return;

    // Overlap guard. A slow cluster making ticks longer than the interval is a
    // real condition worth surfacing, not something to silently swallow
    if (inFlight) {
      log.warn('previous tick still running - skipping this interval', { name, intervalMs });
      return;
    }

    const started = Date.now();
    inFlight = (async () => {
      try {
        await tick();
        if (consecutiveFailures > 0) {
          log.info('tick recovered', { name, afterFailures: consecutiveFailures });
          consecutiveFailures = 0;
        }
        log.debug('tick complete', { name, ms: Date.now() - started });
      } catch (err) {
        consecutiveFailures += 1;
        // Escalate a persistent failure. One bad tick is noise; ten in a row
        // means the cluster or the credentials are gone and nobody has noticed
        const level = consecutiveFailures >= 10 ? 'error' : 'warn';
        log[level]('tick failed', {
          name,
          err,
          consecutiveFailures,
          ms: Date.now() - started,
        });
      } finally {
        inFlight = null;
      }
    })();

    await inFlight;
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      await runOnce();
      schedule();
    }, nextDelay());
    timer.unref?.();
  }

  if (runImmediately) {
    // Fire and forget: startup must not block on the first poll
    runOnce().catch((err) => log.error('initial tick failed', { name, err }));
  }
  schedule();

  return {
    /** Stop scheduling and wait for any tick already in progress */
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) {
        log.info('waiting for in-flight tick to finish', { name });
        try {
          await inFlight;
        } catch {
          /* already logged inside runOnce */
        }
      }
      log.info('runner stopped', { name });
    },

    isRunning: () => Boolean(inFlight),
  };
}

module.exports = { createRunner };