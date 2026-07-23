'use strict';

const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./util/crypto');

/** Ensure the directory for a file path exists */
function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
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