'use strict';

const { isRetryableRequest, isRetryableFailure, retryAfterMs } = require('../src/util/retry');

/*
 * The retry predicates, tested directly rather than through an axios instance.
 * The read-only rule is the safety property: retrying POST /api/cases would
 * hand an analyst two cases for one alert, which is worse than the failure it
 * was trying to paper over
 */

describe('retry policy', () => {
  const failure = (over) => ({ response: undefined, ...over });

  test('reads are retryable, writes are not', () => {
    expect(isRetryableRequest({ method: 'get', url: '/api/cases/x' })).toBe(true);
    expect(isRetryableRequest({ method: 'post', url: '/.alerts-*/_search' })).toBe(true);
    // Creating a case twice is worse than failing once
    expect(isRetryableRequest({ method: 'post', url: '/api/cases' })).toBe(false);
    expect(isRetryableRequest({ method: 'post', url: '/api/cases/x/comments' })).toBe(false);
    expect(isRetryableRequest({ method: 'delete', url: '/api/cases/x' })).toBe(false);
  });

  test('only transient failures are retried', () => {
    expect(isRetryableFailure(failure({ response: { status: 429 } }))).toBe(true);
    expect(isRetryableFailure(failure({ response: { status: 503 } }))).toBe(true);
    expect(isRetryableFailure(failure({ code: 'ECONNRESET' }))).toBe(true);
    // These fail identically the second time
    expect(isRetryableFailure(failure({ response: { status: 400 } }))).toBe(false);
    expect(isRetryableFailure(failure({ response: { status: 401 } }))).toBe(false);
    expect(isRetryableFailure(failure({ response: { status: 404 } }))).toBe(false);
  });

  test('Retry-After is honoured in both formats', () => {
    expect(retryAfterMs({ response: { headers: { 'retry-after': '2' } } })).toBe(2000);
    const future = new Date(Date.now() + 5000).toUTCString();
    expect(retryAfterMs({ response: { headers: { 'retry-after': future } } })).toBeGreaterThan(3000);
    expect(retryAfterMs({ response: { headers: {} } })).toBeNull();
  });
});