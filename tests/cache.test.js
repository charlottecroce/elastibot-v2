'use strict';

const { TtlCache } = require('../src/util/cache');

/*
 * The TTL cache backs three different things - space names, per-API-key Elastic
 * clients, and decrypted user records - so the invariants below are load-bearing
 * in more places than they look. The de-duplication test in particular is the
 * whole reason this isn't a plain Map
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('TtlCache', () => {
  test('entries expire', async () => {
    const cache = new TtlCache({ ttlMs: 30 });
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    await wait(45);
    expect(cache.has('a')).toBe(false);
  });

  test('the size cap evicts the oldest entry', () => {
    const cache = new TtlCache({ ttlMs: 0, max: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.has('a')).toBe(false);
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