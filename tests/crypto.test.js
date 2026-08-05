'use strict';

const { encrypt, decrypt, isEncrypted } = require('../src/util/crypto');

/*
 * This is what stands between data/users.json and someone's Elastic API key, so ciphertext must not leak the plaintext, 
    and a tampered blob must fail rather than decrypt to junk
 */

const SECRET = 'a-long-enough-test-secret-0123456789';
const KEY = 'VnVhQ2ZHY0JDZGJrU29tZUFwaUtleVZhbHVl';

describe('encrypt / decrypt', () => {
  test('round trips', () => {
    const enc = encrypt(KEY, SECRET);
    expect(decrypt(enc, SECRET)).toBe(KEY);
  });

  test('ciphertext is prefixed and contains no plaintext', () => {
    const enc = encrypt(KEY, SECRET);
    expect(isEncrypted(enc)).toBe(true);
    expect(enc.startsWith('enc:')).toBe(true);
    expect(enc).not.toContain(KEY);
  });

  test('same input encrypts differently each time (random IV)', () => {
    expect(encrypt(KEY, SECRET)).not.toBe(encrypt(KEY, SECRET));
  });

  test('no secret configured > value stored as-is', () => {
    expect(encrypt(KEY, undefined)).toBe(KEY);
    expect(isEncrypted(encrypt(KEY, undefined))).toBe(false);
  });

  test('plaintext passes straight back through decrypt', () => {
    expect(decrypt(KEY, SECRET)).toBe(KEY);
    expect(decrypt(undefined, SECRET)).toBeUndefined();
  });

  test('encrypted value + missing secret throws instead of returning garbage', () => {
    const enc = encrypt(KEY, SECRET);
    expect(() => decrypt(enc, undefined)).toThrow(/ELASTIBOT_SECRET_KEY/);
  });

  test('wrong secret fails the GCM auth tag', () => {
    const enc = encrypt(KEY, SECRET);
    expect(() => decrypt(enc, 'not-the-right-secret')).toThrow();
  });

  test('tampered ciphertext fails the GCM auth tag', () => {
    const enc = encrypt(KEY, SECRET);
    const raw = Buffer.from(enc.slice(4), 'base64');
    raw[raw.length - 1] ^= 0xff; // flip a bit in the payload
    expect(() => decrypt(`enc:${raw.toString('base64')}`, SECRET)).toThrow();
  });
});

describe('isEncrypted', () => {
  test('only true for prefixed strings', () => {
    expect(isEncrypted('enc:whatever')).toBe(true);
    expect(isEncrypted('plain')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(12345)).toBe(false);
  });
});