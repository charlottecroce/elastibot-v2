'use strict';

const { installRetry } = require('../src/util/retry');

/*
 * retry.test.js covers the predicates. The interceptor itself - the attempt
 * counter, the give-up path, the actual re-issue of the request - was
 * uncovered, which is where the interesting failure lives: a retry that reuses
 * a config object without incrementing __retryCount is an infinite loop against
 * a cluster that is already struggling
 *
 * baseDelayMs is 1 throughout, so the jittered backoff is at most a millisecond
 */

/** An axios-shaped instance that hands back its rejection interceptor */
function fakeInstance() {
  const instance = {
    onRejected: null,
    request: jest.fn().mockResolvedValue({ data: 'ok' }),
    interceptors: {
      response: {
        use: (_onFulfilled, onRejected) => {
          instance.onRejected = onRejected;
        },
      },
    },
  };
  return instance;
}

const readCfg = (over = {}) => ({ method: 'get', url: '/api/cases/x', ...over });

const failure = (cfg, over = {}) => ({ config: cfg, ...over });

describe('installRetry', () => {
  test('retries=0 installs nothing at all', () => {
    const instance = fakeInstance();
    expect(installRetry(instance, { retries: 0 })).toBe(instance);
    expect(instance.onRejected).toBeNull();
  });

  test('a transient failure on a read is re-issued with the attempt counted', async () => {
    const instance = fakeInstance();
    installRetry(instance, { retries: 2, baseDelayMs: 1 });

    const cfg = readCfg();
    await instance.onRejected(failure(cfg, { response: { status: 503 } }));

    expect(instance.request).toHaveBeenCalledWith(cfg);
    expect(cfg.__retryCount).toBe(1);
  });

  test('the counter keeps climbing across retries of the same request', async () => {
    // Sharing one config object across attempts is how axios works; if this
    // does not increment, the give-up branch is never reached
    const instance = fakeInstance();
    installRetry(instance, { retries: 3, baseDelayMs: 1 });

    const cfg = readCfg();
    await instance.onRejected(failure(cfg, { response: { status: 429 } }));
    await instance.onRejected(failure(cfg, { response: { status: 429 } }));

    expect(cfg.__retryCount).toBe(2);
    expect(instance.request).toHaveBeenCalledTimes(2);
  });

  test('it gives up once the budget is spent and rejects with the original error', async () => {
    const instance = fakeInstance();
    installRetry(instance, { retries: 1, baseDelayMs: 1 });

    const cfg = readCfg();
    await instance.onRejected(failure(cfg, { response: { status: 503 } }));

    const last = failure(cfg, { response: { status: 503 } });
    await expect(instance.onRejected(last)).rejects.toBe(last);
    expect(instance.request).toHaveBeenCalledTimes(1); // not re-issued
  });

  test('a write is never retried, however transient the failure looks', async () => {
    // A duplicate case is worse than a failed one
    const instance = fakeInstance();
    installRetry(instance, { retries: 2, baseDelayMs: 1 });

    const err = failure(readCfg({ method: 'post', url: '/api/cases' }), {
      response: { status: 503 },
    });

    await expect(instance.onRejected(err)).rejects.toBe(err);
    expect(instance.request).not.toHaveBeenCalled();
  });

  test('a permanent failure on a read is not retried either', async () => {
    const instance = fakeInstance();
    installRetry(instance, { retries: 2, baseDelayMs: 1 });

    const err = failure(readCfg(), { response: { status: 404 } });

    await expect(instance.onRejected(err)).rejects.toBe(err);
    expect(instance.request).not.toHaveBeenCalled();
  });

  test('an error with no config at all is passed straight through', async () => {
    // Request-setup failures never reached the wire; there is nothing to re-issue
    const instance = fakeInstance();
    installRetry(instance, { retries: 2, baseDelayMs: 1 });

    const err = { message: 'no config here' };
    await expect(instance.onRejected(err)).rejects.toBe(err);
  });

  test('Retry-After overrides the computed backoff', async () => {
    const instance = fakeInstance();
    installRetry(instance, { retries: 2, baseDelayMs: 1 });

    const started = Date.now();
    await instance.onRejected(
      failure(readCfg(), { response: { status: 429, headers: { 'retry-after': '0.05' } } })
    );

    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(instance.request).toHaveBeenCalled();
  });
});