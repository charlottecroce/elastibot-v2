'use strict';

const fs = require('fs');
const config = require('../config');
const { encrypt, decrypt } = require('./util/crypto');
const { writeJsonAtomicSync } = require('./util/atomicFile');
const { TtlCache, MISS } = require('./util/cache');
const { logger } = require('./util/logger');

const log = logger.child({ scope: 'store' });

/*
 * A missing file is normal (first boot). A file that exists but won't parse is
 * NOT normal. Distinguish the two and alert about the second
 */
function readJson(filePath, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.error('could not read store file - starting empty', { err, filePath });
    } else {
      log.debug('no store file yet - starting empty', { filePath });
    }
    return fallback;
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    log.error('store file is corrupt - starting empty, existing records are NOT loaded', {
      err,
      filePath,
      bytes: raw.length,
      remedy: 'restore from backup before restarting, or the contents are lost',
    });
    return fallback;
  }
}

/**
 * Shared persistence behaviour: atomic writes, an optional write-behind delay,
 * and an explicit flush for shutdown
 *
 * debounceMs defaults to 0 (write-through), which keeps `set()` synchronous from
 * the caller's point of view
 */
class JsonFileStore {
  constructor({ filePath, debounceMs = 0 }) {
    this.filePath = filePath;
    this.debounceMs = debounceMs;
    this.data = readJson(filePath, {});
    this._timer = null;
    this._dirty = false;
  }

  _persist() {
    this._dirty = true;

    if (this.debounceMs > 0) {
      if (this._timer) return;
      this._timer = setTimeout(() => {
        this._timer = null;
        this.flush();
      }, this.debounceMs);
      this._timer.unref?.(); // a pending flush must not hold the process open
      return;
    }
    this._writeNow();
  }

  _writeNow() {
    if (!this._dirty) return;
    try {
      writeJsonAtomicSync(this.filePath, this.data, { mode: 0o600 });
      this._dirty = false;
    } catch (err) {
      // Losing a write is bad, but crashing the watcher loop over it is worse
      log.error('failed to persist store', { err, filePath: this.filePath });
    }
  }

  /** Write any pending changes immediately. Call before exit */
  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._writeNow();
  }
}

/**
 * Maps Slack user IDs > { kibanaUsername, apiKey }
 * apiKey is encrypted at rest when an encryptionKey is provided
 *
 * Always write-through: this holds credentials, and a registration that appeared
 * to succeed must survive an immediate crash
 */
class UserStore extends JsonFileStore {
  constructor({ filePath, encryptionKey, cacheTtlMs = config.cache.userTtlMs }) {
    super({ filePath, debounceMs: 0 });
    this.encryptionKey = encryptionKey;

    // Decrypted records are cached because scrypt derivation is ~50-100ms and
    // get() runs on every command with requireUser. Invalidated on set/delete.
    //
    // The 1ms floor is deliberate, not a typo: TtlCache reads ttlMs === 0 as
    // "never expire", but USER_CACHE_TTL_MS=0 from an operator means the
    // opposite - "don't cache". 1ms is the closest expressible equivalent
    this._cache = new TtlCache({ ttlMs: cacheTtlMs > 0 ? cacheTtlMs : 1, max: 500 });

    log.debug('user store loaded', { filePath, users: Object.keys(this.data).length });
  }

  /** Returns { kibanaUsername, apiKey } with apiKey decrypted, or null */
  get(slackUserId) {
    const cached = this._cache.get(slackUserId);
    if (cached !== MISS) return cached;

    const rec = this.data[slackUserId];
    if (!rec) return this._cache.set(slackUserId, null);

    const decrypted = {
      kibanaUsername: rec.kibanaUsername,
      apiKey: decrypt(rec.apiKey, this.encryptionKey),
      updatedAt: rec.updatedAt,
    };
    return this._cache.set(slackUserId, decrypted);
  }

  has(slackUserId) {
    return Boolean(this.data[slackUserId]);
  }

  set(slackUserId, { kibanaUsername, apiKey }) {
    this.data[slackUserId] = {
      kibanaUsername,
      apiKey: encrypt(apiKey, this.encryptionKey),
      updatedAt: new Date().toISOString(),
    };
    this._cache.delete(slackUserId);
    this._persist();
  }

  delete(slackUserId) {
    delete this.data[slackUserId];
    this._cache.delete(slackUserId);
    this._persist();
  }

  /** Drop every decrypted record from memory. Called on shutdown */
  clearCache() {
    this._cache.clear();
  }
}

/**
 * Generic persisted key/value state for the watchers (last-seen timestamps)
 */
class StateStore extends JsonFileStore {
  constructor({ filePath, debounceMs = 0 }) {
    super({ filePath, debounceMs });
  }

  /**
   * Object values are returned as copies, so callers must go through set() to
   * persist and an accidental mutation can't desync memory from disk
   */
  get(key, fallback) {
    if (!(key in this.data)) return fallback;
    const value = this.data[key];
    return value && typeof value === 'object' ? structuredClone(value) : value;
  }

  set(key, value) {
    this.data[key] = value;
    this._persist();
  }
}

module.exports = { UserStore, StateStore, JsonFileStore };