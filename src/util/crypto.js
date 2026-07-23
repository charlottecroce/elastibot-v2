'use strict';

/*
 * AES-256-GCM helper used to encrypt each analyst's Elastic API key
 * before it touches disk. The encryption key comes from config.security.encryptionKey
 * (env: ELASTIBOT_SECRET_KEY). If that isn't set, encryption is skipped and the
 * caller is expected to warn the operator.
 *
 * Encrypted values are prefixed with "enc:" so we can detect and decrypt them later
 */

const crypto = require('crypto');

const PREFIX = 'enc:';

function deriveKey(secret) {
  // Normalize any-length secret into a 32-byte key
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encrypt(plaintext, secret) {
  if (!secret) return plaintext; // no key configured > store as-is
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(value, secret) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value; // plaintext
  if (!secret) {
    throw new Error('Stored value is encrypted but ELASTIBOT_SECRET_KEY is not set.');
  }
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

module.exports = { encrypt, decrypt, isEncrypted };