'use strict';

const { logger } = require('./logger');

/*
 * Retry for transient Elastic failures.
 *
 * Today a single 503 during a cluster rebalance, or a 429 when someone runs
 * /stats over 90 days while the watchers are polling, fails the analyst's whole
 * command. They see an error, retype it, and it works. That's a retry - just a
 * manual one performed by a human under time pressure during an incident.
 *
 * Two rules keep this safe:
 *
 *   1. READS ONLY. GET is safe by definition, and the two POSTs we retry
 *      (_search) are reads that happen to use POST because they carry a body.
 *      Case creation and alert attachment are never retried - a duplicate case
 *      is worse than a failed one, and the analyst can see the failure and retry
 *      deliberately
 *   2. Only transient statuses: 429, 502, 503, 504, and network-level timeouts
 *      or resets. A 400 or 404 will fail identically the second time; retrying
 *      just makes the analyst wait longer for the same answer
 *
 * Backoff is exponential with full jitter, and honours Retry-After when Elastic
 * sends one
 */

const log = logger.child({ scope: 'elastic:retry' });

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'ECONNABORTED', // axios timeout
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN', // transient DNS
]);

/** Paths that are reads even though they're issued as POST */
const READ_ONLY_POST_RE = /\/_search$|\/_count$|\/_msearch$/;

function isRetryableRequest(cfg) {
  if (!cfg) return false;
  const method = String(cfg.method || 'get').toLowerCase();
  if (method === 'get' || method === 'head') return true;
  if (method === 'post') return READ_ONLY_POST_RE.test(String(cfg.url || ''));
  return false;
}

function isRetryableFailure(err) {
  const status = err?.response?.status;
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  return RETRYABLE_CODES.has(err?.code);
}

/** Respect Retry-After (seconds, or an HTTP date) when the server sends one */
function retryAfterMs(err) {
  const header = err?.response?.headers?.['retry-after'];
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const when = Date.parse(header);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

/** Exponential backoff with full jitter, so concurrent callers don't sync up */
function backoffMs(attempt, baseMs) {
  const ceiling = baseMs * 2 ** (attempt - 1);
  return Math.round(Math.random() * ceiling);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Install retry on an axios instance.
 *
 * @param {object} instance axios instance
 * @param {object} opts
 * @param {number} opts.retries      max additional attempts (0 disables)
 * @param {number} opts.baseDelayMs
 * @param {string} [opts.name]       for logs, e.g. 'es' or 'kibana'
 */
function installRetry(instance, { retries = 2, baseDelayMs = 250, name = 'elastic' } = {}) {
  if (retries <= 0) return instance;

  instance.interceptors.response.use(undefined, async (err) => {
    const cfg = err?.config;

    if (!cfg || !isRetryableRequest(cfg) || !isRetryableFailure(err)) {
      return Promise.reject(err);
    }

    cfg.__retryCount = cfg.__retryCount || 0;
    if (cfg.__retryCount >= retries) {
      log.warn('giving up after retries', {
        name,
        url: cfg.url,
        attempts: cfg.__retryCount + 1,
        status: err?.response?.status,
        code: err?.code,
      });
      return Promise.reject(err);
    }

    cfg.__retryCount += 1;
    const delay = retryAfterMs(err) ?? backoffMs(cfg.__retryCount, baseDelayMs);

    log.debug('retrying transient failure', {
      name,
      url: cfg.url,
      attempt: cfg.__retryCount,
      delayMs: delay,
      status: err?.response?.status,
      code: err?.code,
    });

    await sleep(delay);
    return instance.request(cfg);
  });

  return instance;
}

module.exports = { installRetry, isRetryableRequest, isRetryableFailure, retryAfterMs };