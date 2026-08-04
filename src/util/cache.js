'use strict';

/*
 * A small TTL cache with a size cap and in-flight de-duplication.
 *
 * Deliberately not an LRU: entries expire by time, and the size cap evicts the
 * oldest insertion. Space names and API-key-keyed clients are both small, bounded
 * sets - an LRU's bookkeeping would cost more than it saves
 */

class TtlCache {
  /**
   * @param {object} opts
   * @param {number} opts.ttlMs      how long an entry stays fresh (0 = forever)
   * @param {number} [opts.max]      hard cap on entries; oldest evicted first
   * @param {function} [opts.onEvict] called with (key, value) when an entry is dropped
   */
  constructor({ ttlMs, max = 500, onEvict = null } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.onEvict = onEvict;
    this.entries = new Map(); // key > { value, expires }
    this.inflight = new Map(); // key > Promise
  }

  get size() {
    return this.entries.size;
  }

  _expired(entry) {
    return this.ttlMs > 0 && Date.now() > entry.expires;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this._expired(entry)) {
      this.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
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
    if (this.onEvict) for (const [k, e] of this.entries) this.onEvict(k, e.value);
    this.entries.clear();
    this.inflight.clear();
  }

  /** Synchronous variant: build the value on miss */
  getOrCreate(key, factory) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    return this.set(key, factory(key));
  }

  /**
   * Async variant. Concurrent callers for the same key share one load.
   * A rejected load is NOT cached - the next caller retries
   */
  async getOrLoad(key, loader) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const value = await loader(key);
        if (value !== undefined) this.set(key, value);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

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

module.exports = { TtlCache };