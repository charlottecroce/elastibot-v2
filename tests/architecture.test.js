'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { TtlCache } = require('../src/util/cache');
const { writeJsonAtomicSync } = require('../src/util/atomicFile');
const { createRunner } = require('../src/watchers/runner');
const { isRetryableRequest, isRetryableFailure, retryAfterMs } = require('../src/util/retry');
const { validateConfig } = require('../config/validate');
const { createSpaceService } = require('../src/services/spaceService');
const { StateStore } = require('../src/store');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('TtlCache', () => {
  test('entries expire', async () => {
    const cache = new TtlCache({ ttlMs: 30 });
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    await wait(45);
    expect(cache.get('a')).toBeUndefined();
  });

  test('the size cap evicts the oldest entry', () => {
    const cache = new TtlCache({ ttlMs: 0, max: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  test('concurrent loads for the same key share one call', async () => {
    const cache = new TtlCache({ ttlMs: 1000 });
    const loader = jest.fn(async () => {
      await wait(10);
      return 'value';
    });

    const all = await Promise.all([
      cache.getOrLoad('k', loader),
      cache.getOrLoad('k', loader),
      cache.getOrLoad('k', loader),
    ]);

    expect(loader).toHaveBeenCalledTimes(1); // this is the whole point
    expect(all).toEqual(['value', 'value', 'value']);
  });

  test('a failed load is not cached', async () => {
    const cache = new TtlCache({ ttlMs: 1000 });
    await expect(cache.getOrLoad('k', async () => { throw new Error('nope'); })).rejects.toThrow();
    await expect(cache.getOrLoad('k', async () => 'second time')).resolves.toBe('second time');
  });
});

describe('atomic writes', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('writes the file with restrictive permissions and creates the directory', () => {
    const target = path.join(dir, 'nested', 'state.json');
    writeJsonAtomicSync(target, { cursor: '2026-07-30T12:00:00.000Z' });
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).cursor).toBe('2026-07-30T12:00:00.000Z');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  test('leaves no temp files behind', () => {
    const target = path.join(dir, 'state.json');
    writeJsonAtomicSync(target, { a: 1 });
    writeJsonAtomicSync(target, { a: 2 });
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  test('the previous contents survive a failed write', () => {
    const target = path.join(dir, 'state.json');
    writeJsonAtomicSync(target, { good: true });
    const circular = {}; circular.self = circular;
    expect(() => writeJsonAtomicSync(target, circular)).toThrow();
    // The old file is intact, not truncated - the point of the rename
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ good: true });
  });
});

describe('StateStore', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('write-through is still the default, so a reopened store sees the value', () => {
    const p = path.join(dir, 'state.json');
    new StateStore({ filePath: p }).set('alertsLastTs', 'ts-1');
    expect(new StateStore({ filePath: p }).get('alertsLastTs', null)).toBe('ts-1');
  });

  test('with a debounce, flush() forces the pending write out', () => {
    const p = path.join(dir, 'state.json');
    const store = new StateStore({ filePath: p, debounceMs: 5000 });
    store.set('alertsLastTs', 'ts-2');
    expect(fs.existsSync(p)).toBe(false); // still buffered
    store.flush();
    expect(new StateStore({ filePath: p }).get('alertsLastTs', null)).toBe('ts-2');
  });
});

describe('space service', () => {
  test('one lookup serves every caller for that space', async () => {
    const client = { getSpaceName: jest.fn().mockResolvedValue('Security Operations') };
    const spaces = createSpaceService({ ttlMs: 10000 });

    await Promise.all([
      spaces.getName('soc', client),
      spaces.getName('soc', client),
    ]);
    await spaces.getName('soc', client);

    expect(client.getSpaceName).toHaveBeenCalledTimes(1);
  });

  test('a lookup failure falls back to the id and does not throw', async () => {
    const client = { getSpaceName: jest.fn().mockRejectedValue(new Error('kibana down')) };
    const spaces = createSpaceService({ ttlMs: 10000 });
    await expect(spaces.getName('soc', client)).resolves.toBe('soc');
  });

  test('invalidate forces a re-read after a rename', async () => {
    const client = { getSpaceName: jest.fn()
      .mockResolvedValueOnce('Old Name')
      .mockResolvedValueOnce('New Name') };
    const spaces = createSpaceService({ ttlMs: 10000 });

    expect(await spaces.getName('soc', client)).toBe('Old Name');
    spaces.invalidate('soc');
    expect(await spaces.getName('soc', client)).toBe('New Name');
  });
});

describe('watcher runner', () => {
  test('stop() waits for the tick already in flight', async () => {
    let finished = false;
    const runner = createRunner({
      intervalMs: 10000,
      tick: async () => { await wait(60); finished = true; },
    });

    await wait(10); // let the immediate tick start
    await runner.stop();
    expect(finished).toBe(true); // this is what the old clearInterval could not do
  });

  test('a tick is skipped rather than overlapped', async () => {
    let started = 0;
    const runner = createRunner({
      intervalMs: 20,
      jitterRatio: 0,
      tick: async () => { started += 1; await wait(120); },
    });

    await wait(90);
    await runner.stop();
    expect(started).toBe(1); // several intervals elapsed, none overlapped
  });

  test('a throwing tick does not stop the loop', async () => {
    let calls = 0;
    const runner = createRunner({
      intervalMs: 20,
      jitterRatio: 0,
      tick: async () => { calls += 1; throw new Error('elastic is down'); },
    });

    await wait(90);
    await runner.stop();
    expect(calls).toBeGreaterThan(1);
  });
});

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

describe('config validation', () => {
  /** A config that passes, which each test then breaks in one specific way */
  const valid = () => ({
    shutdownTimeoutMs: 15000,
    slack: { botToken: 'xoxb-1', signingSecret: 's', appToken: 'xapp-1', socketMode: true, port: 3000 },
    elastic: {
      kibanaUrl: 'https://kibana.internal:5601',
      kibanaPublicUrl: 'https://kibana.internal:5601',
      esUrl: 'https://es.internal:9200',
      serviceApiKey: 'k',
      tlsRejectUnauthorized: true,
      requestTimeoutMs: 15000,
    },
    logging: { level: 'info', format: 'json', redact: true },
    security: { encryptionKey: 'a'.repeat(32), userStorePath: './data/users.json', statePath: './data/state.json' },
    stats: { maxWindowDays: 90, topN: 10, timeZone: 'UTC' },
    watchers: {
      enabled: true, pollIntervalMs: 60000, jitterRatio: 0.1, fetchSize: 200, postDelayMs: 300,
      defaultChannel: 'C1', channelRouting: {},
      alerts: { enabled: true }, cases: { enabled: true, spaces: ['default'] },
    },
  });

  const check = (mutate) => {
    const cfg = valid();
    mutate(cfg);
    return validateConfig(cfg, { throwOnError: false });
  };

  test('a good config produces no errors', () => {
    expect(validateConfig(valid(), { throwOnError: false }).errors).toEqual([]);
  });

  test('every missing required value is reported at once, not just the first', () => {
    const { errors } = check((c) => {
      c.slack.botToken = undefined;
      c.slack.signingSecret = undefined;
      c.elastic.kibanaUrl = undefined;
    });
    expect(errors).toHaveLength(3);
  });

  test('a malformed URL is caught at boot instead of at first use', () => {
    const { errors } = check((c) => { c.elastic.esUrl = 'es.internal:9200'; });
    expect(errors.join()).toMatch(/ELASTICSEARCH_URL/);
  });

  test('a bad timezone is caught at boot', () => {
    const { errors } = check((c) => { c.stats.timeZone = 'America/Nowhere'; });
    expect(errors.join()).toMatch(/STATS_TIMEZONE/);
  });

  test('an unencrypted key store is a warning, not a hard failure', () => {
    const { errors, warnings } = check((c) => { c.security.encryptionKey = undefined; });
    expect(errors).toEqual([]);
    expect(warnings.join()).toMatch(/ELASTIBOT_SECRET_KEY/);
  });

  test('watchers enabled without a service key warns rather than dying', () => {
    const { errors, warnings } = check((c) => { c.elastic.serviceApiKey = undefined; });
    expect(errors).toEqual([]);
    expect(warnings.join()).toMatch(/watchers will not run/);
  });

  test('a rate-limit-inviting post delay is flagged', () => {
    const { warnings } = check((c) => { c.watchers.postDelayMs = 0; });
    expect(warnings.join()).toMatch(/rate limit/);
  });

  test('validateConfig throws a ConfigError listing everything', () => {
    const cfg = valid();
    cfg.slack.botToken = undefined;
    cfg.elastic.esUrl = undefined;
    expect(() => validateConfig(cfg)).toThrow(/SLACK_BOT_TOKEN[\s\S]*ELASTICSEARCH_URL/);
  });
});