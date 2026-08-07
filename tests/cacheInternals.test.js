'use strict';

const { TtlCache } = require('../src/util/cache');

/*
 * cache.test.js covers the four properties the cache exists for. This file
 * coversthe synchronous variant, the eviction
 * callback (which is what drops decrypted API keys out of memory), and the
 * constructor guards
 */

describe('TtlCache: construction', () => {
  test('a nonsense ttl is rejected at construction rather than at first use', () => {
    // A cache built with ttlMs: undefined silently never expires anything,
    // which is exactly the bug you do not find until a key rotation
    expect(() => new TtlCache({})).toThrow(TypeError);
    expect(() => new TtlCache({ ttlMs: -1 })).toThrow(TypeError);
    expect(() => new TtlCache({ ttlMs: NaN })).toThrow(TypeError);
  });

  test('a nonsense size cap is rejected too', () => {
    expect(() => new TtlCache({ ttlMs: 10, max: 0 })).toThrow(TypeError);
    expect(() => new TtlCache({ ttlMs: 10, max: 2.5 })).toThrow(TypeError);
  });

  test('ttlMs of 0 means never expire', () => {
    const cache = new TtlCache({ ttlMs: 0 });
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });
});

describe('TtlCache: getOrCreate', () => {
  test('the factory runs once and the value is reused', () => {
    const cache = new TtlCache({ ttlMs: 1000 });
    const factory = jest.fn(() => ({ client: true }));

    const first = cache.getOrCreate('k', factory);
    const second = cache.getOrCreate('k', factory);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(second).toBe(first); // identity matters - this caches HTTP clients
  });

  test('the factory receives the key', () => {
    const cache = new TtlCache({ ttlMs: 1000 });
    expect(cache.getOrCreate('space-a', (k) => `client:${k}`)).toBe('client:space-a');
  });

  test('a cached undefined is still a hit', () => {
    // This is why get() returns a MISS symbol rather than undefined
    const cache = new TtlCache({ ttlMs: 1000 });
    const factory = jest.fn(() => undefined);

    cache.getOrCreate('k', factory);
    cache.getOrCreate('k', factory);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(cache.has('k')).toBe(true);
  });
});

describe('TtlCache: onEvict', () => {
  test('fires on an explicit delete', () => {
    const onEvict = jest.fn();
    const cache = new TtlCache({ ttlMs: 1000, onEvict });

    cache.set('k', 'secret');
    cache.delete('k');

    expect(onEvict).toHaveBeenCalledWith('k', 'secret');
  });

  test('fires when the size cap pushes the oldest entry out', () => {
    const onEvict = jest.fn();
    const cache = new TtlCache({ ttlMs: 1000, max: 1, onEvict });

    cache.set('a', 1);
    cache.set('b', 2);

    expect(onEvict).toHaveBeenCalledWith('a', 1);
  });

  test('fires for every entry on clear', () => {
    // ctx.close() leans on this to drop decrypted keys at shutdown
    const onEvict = jest.fn();
    const cache = new TtlCache({ ttlMs: 1000, onEvict });

    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();

    expect(onEvict).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  test('fires when an expired entry is read out', () => {
    const onEvict = jest.fn();
    const cache = new TtlCache({ ttlMs: 1, onEvict });
    cache.set('k', 'secret');

    return new Promise((r) => setTimeout(r, 10)).then(() => {
      expect(cache.get('k')).not.toBe('secret');
      expect(onEvict).toHaveBeenCalledWith('k', 'secret');
    });
  });

  test('overwriting a key in place does not evict, and does not grow the cache', () => {
    const onEvict = jest.fn();
    const cache = new TtlCache({ ttlMs: 1000, max: 2, onEvict });

    cache.set('a', 1);
    cache.set('a', 2);

    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe(2);
    expect(onEvict).not.toHaveBeenCalled();
  });

  test('clear also drops anything mid-flight', async () => {
    const cache = new TtlCache({ ttlMs: 1000 });
    const load = cache.getOrLoad('k', async () => 'value');
    cache.clear();
    await expect(load).resolves.toBe('value'); // in-flight callers still settle
    expect(cache.size).toBe(0);
  });
});