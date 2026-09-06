'use strict';

/*
 * AES-256-GCM helper used to encrypt each analyst's Elastic API key before it
 * touches disk. The encryption key comes from config.security.encryptionKey
 * (env: ELASTIBOT_SECRET_KEY). If that isn't set, encryption is skipped and the
 * caller is expected to warn the operator.
 *
 * Key derivation is scrypt with a per-value random salt.
 *
 * Envelope (base64, after the "enc:" prefix):
 *   [1 byte version][16 byte salt][12 byte iv][16 byte gcm tag][ciphertext]
 */

const crypto = require('crypto');

const PREFIX = 'enc:';
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

// ~50-100ms per derivation. Callers must not derive per request; UserStore
// caches the decrypted record
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(secret, salt) {
  return crypto.scryptSync(String(secret), salt, 32, SCRYPT);
}

function encrypt(plaintext, secret) {
  if (!secret) return plaintext; // no key configured > store as-is

  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);

  const envelope = Buffer.concat([
    Buffer.from([VERSION]),
    salt,
    iv,
    cipher.getAuthTag(),
    enc,
  ]);
  return PREFIX + envelope.toString('base64');
}

function decrypt(value, secret) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value; // plaintext
  if (!secret) {
    throw new Error('Stored value is encrypted but ELASTIBOT_SECRET_KEY is not set.');
  }

  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  if (raw.length < 1 + SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error('Stored value is truncated or not a valid ciphertext envelope.');
  }

  const version = raw[0];
  if (version !== VERSION) {
    throw new Error(
      `Unsupported ciphertext version ${version} - the analyst must re-run \`/start\`.`
    );
  }

  let off = 1;
  const salt = raw.subarray(off, (off += SALT_LEN));
  const iv = raw.subarray(off, (off += IV_LEN));
  const tag = raw.subarray(off, (off += TAG_LEN));
  const data = raw.subarray(off);

  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

module.exports = { encrypt, decrypt, isEncrypted, VERSION };