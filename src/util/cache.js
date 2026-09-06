'use strict';

/*
 * A small TTL cache with a size cap and in-flight de-duplication.
 *
 * Not an LRU: entries expire by time, and the size cap evicts the oldest
 * insertion. Space names, API-key-keyed clients and decrypted user records are
 * all small, bounded sets
 *
 * `get` returns the MISS symbol on a miss, so a cached `undefined` or `null` is
 * still a hit
 */

const MISS = Symbol('cache-miss');

class TtlCache {
  /**
   * @param {object} opts
   * @param {number} opts.ttlMs      how long an entry stays fresh (0 = forever)
   * @param {number} [opts.max]      hard cap on entries; oldest evicted first
   * @param {function} [opts.onEvict] called with (key, value) when an entry is dropped
   */
  constructor({ ttlMs, max = 500, onEvict = null } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new TypeError(`TtlCache ttlMs must be a non-negative number, got ${ttlMs}`);
    }
    if (!Number.isInteger(max) || max <= 0) {
      throw new TypeError(`TtlCache max must be a positive integer, got ${max}`);
    }
    this.ttlMs = ttlMs;
    this.max = max;
    this.onEvict = onEvict;
    this.entries = new Map(); // key > { value, expires }
    this.inflight = new Map(); // key > Promise
    this._epoch = 0;
  }

  get size() {
    return this.entries.size;
  }

  _expired(entry) {
    return this.ttlMs > 0 && Date.now() > entry.expires;
  }

  /** @returns the cached value, or the MISS symbol */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return MISS;
    if (this._expired(entry)) {
      this.delete(key);
      return MISS;
    }
    return entry.value;
  }

  has(key) {
    return this.get(key) !== MISS;
  }

  set(key, value) {
    // Evict the oldest entry once we're at capacity (Map preserves insertion order)
    if (!this.entries.has(key) && this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      this.delete(oldest);
    }
    this.entries.set(key, {
      value,
      expires: this.ttlMs > 0 ? Date.now() + this.ttlMs : Infinity,
    });
    return value;
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (entry && this.onEvict) this.onEvict(key, entry.value);
    return this.entries.delete(key);
  }

  clear() {
    this._epoch += 1;
    if (this.onEvict) for (const [k, e] of this.entries) this.onEvict(k, e.value);
    this.entries.clear();
    this.inflight.clear();
  }

  /** Synchronous variant: build the value on miss */
  getOrCreate(key, factory) {
    const hit = this.get(key);
    if (hit !== MISS) return hit;
    return this.set(key, factory(key));
  }

  /**
   * Async variant. Concurrent callers for the same key share one load.
   * A rejected load is NOT cached - the next caller retries
   */
  async getOrLoad(key, loader) {
    const hit = this.get(key);
    if (hit !== MISS) return hit;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    // Captured before the loader runs. If clear() bumps _epoch while this
    // load is in flight, the eventual .then() below must not write the result
    // back into `entries` - that would resurrect an entry the caller already
    // asked to be rid of
    const epoch = this._epoch;

    // The loader runs on a later tick, so the inflight entry below is always
    // registered before the cleanup can run. Invoking it inline would let a
    // synchronously-throwing loader delete the entry first, stranding the
    // rejected promise in the map for good
    const promise = Promise.resolve()
      .then(() => loader(key))
      .then((value) => {
        if (epoch === this._epoch) this.set(key, value);
        return value;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }

  /** Drop expired entries. Worth calling periodically on long-lived caches */
  prune() {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (this._expired(entry)) {
        this.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }
}

module.exports = { TtlCache, MISS };