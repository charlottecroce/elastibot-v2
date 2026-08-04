'use strict';

const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./util/crypto');
const { logger } = require('./util/logger');

const log = logger.child({ scope: 'store' });

/** Ensure the directory for a file path exists */
function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

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
      remedy: 'restore the file from backup, or analysts will need to re-run /start',
    });
    return fallback;
  }
}

function writeJson(filePath, obj) {
  ensureDir(filePath);
  // Restrictive permissions since this may hold secrets
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

/**
 * Maps Slack user IDs > { kibanaUsername, apiKey }
 * apiKey is encrypted at rest when an encryptionKey is provided
 */
class UserStore {
  constructor({ filePath, encryptionKey }) {
    this.filePath = filePath;
    this.encryptionKey = encryptionKey;
    this.data = readJson(filePath, {});
    log.debug('user store loaded', { filePath, users: Object.keys(this.data).length });
  }

  /** Returns { kibanaUsername, apiKey } with apiKey decrypted, or null */
  get(slackUserId) {
    const rec = this.data[slackUserId];
    if (!rec) return null;
    return {
      kibanaUsername: rec.kibanaUsername,
      apiKey: decrypt(rec.apiKey, this.encryptionKey),
      updatedAt: rec.updatedAt,
    };
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
    writeJson(this.filePath, this.data);
  }

  delete(slackUserId) {
    delete this.data[slackUserId];
    writeJson(this.filePath, this.data);
  }
}

/**
 * Generic persisted key/value state for the watchers (last-seen timestamps)
 */
class StateStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.data = readJson(filePath, {});
  }

  get(key, fallback) {
    return key in this.data ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    writeJson(this.filePath, this.data);
  }
}

module.exports = { UserStore, StateStore };