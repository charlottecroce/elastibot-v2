'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { UserStore, StateStore } = require('../src/store');

/*
 * The user store holds Elastic API keys. The tests below are mostly about the file on disk rather than the in-memory object:
        encrypted, 0600, and reloaded after a restart
 */

const SECRET = 'a-long-enough-test-secret-0123456789';
const KEY = 'VnVhQ2ZHY0JDZGJrU29tZUFwaUtleQ==';

let dir;
let userPath;
let statePath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elastibot-test-'));
  userPath = path.join(dir, 'nested', 'users.json');
  statePath = path.join(dir, 'state.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('UserStore', () => {
  test('set then get round trips the record', () => {
    const store = new UserStore({ filePath: userPath, encryptionKey: SECRET });
    store.set('U123', { kibanaUsername: 'jsmith', apiKey: KEY });

    const rec = store.get('U123');
    expect(rec.kibanaUsername).toBe('jsmith');
    expect(rec.apiKey).toBe(KEY);
    expect(Date.parse(rec.updatedAt)).not.toBeNaN();
  });

  test('the key on disk is encrypted, not the raw value', () => {
    const store = new UserStore({ filePath: userPath, encryptionKey: SECRET });
    store.set('U123', { kibanaUsername: 'jsmith', apiKey: KEY });

    const onDisk = fs.readFileSync(userPath, 'utf8');
    expect(onDisk).not.toContain(KEY);
    expect(JSON.parse(onDisk).U123.apiKey.startsWith('enc:')).toBe(true);
  });

  test('the file is written 0600 and its directory is created', () => {
    const store = new UserStore({ filePath: userPath, encryptionKey: SECRET });
    store.set('U123', { kibanaUsername: 'jsmith', apiKey: KEY });
    expect(fs.statSync(userPath).mode & 0o777).toBe(0o600);
  });

  test('a second store reading the same file decrypts what the first wrote', () => {
    new UserStore({ filePath: userPath, encryptionKey: SECRET }).set('U123', {
      kibanaUsername: 'jsmith',
      apiKey: KEY,
    });
    const reopened = new UserStore({ filePath: userPath, encryptionKey: SECRET });
    expect(reopened.get('U123').apiKey).toBe(KEY);
  });

  test('without an encryption key the value is stored in the clear', () => {
    const store = new UserStore({ filePath: userPath });
    store.set('U123', { kibanaUsername: 'jsmith', apiKey: KEY });
    expect(fs.readFileSync(userPath, 'utf8')).toContain(KEY);
    expect(store.get('U123').apiKey).toBe(KEY);
  });

  test('has and delete', () => {
    const store = new UserStore({ filePath: userPath, encryptionKey: SECRET });
    expect(store.has('U123')).toBe(false);
    store.set('U123', { kibanaUsername: 'jsmith', apiKey: KEY });
    expect(store.has('U123')).toBe(true);
    store.delete('U123');
    expect(store.has('U123')).toBe(false);
    expect(store.get('U123')).toBeNull();
  });

  test('an unknown user is null, not a throw', () => {
    expect(new UserStore({ filePath: userPath }).get('nobody')).toBeNull();
  });

  test('a corrupt store file falls back to empty instead of crashing at boot', () => {
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, '{ this is not json');
    const store = new UserStore({ filePath: userPath, encryptionKey: SECRET });
    expect(store.has('U123')).toBe(false);
  });
});

describe('StateStore', () => {
  test('get returns the fallback until something is set', () => {
    const state = new StateStore({ filePath: statePath });
    expect(state.get('alertsLastTs', null)).toBeNull();
    state.set('alertsLastTs', '2026-07-30T12:00:00.000Z');
    expect(state.get('alertsLastTs', null)).toBe('2026-07-30T12:00:00.000Z');
  });

  test('values survive a restart', () => {
    new StateStore({ filePath: statePath }).set('casesLastTs', { default: '2026-07-30T12:00:00.000Z' });
    const reopened = new StateStore({ filePath: statePath });
    expect(reopened.get('casesLastTs', {})).toEqual({ default: '2026-07-30T12:00:00.000Z' });
  });

  test('a stored falsy value is not mistaken for missing', () => {
    const state = new StateStore({ filePath: statePath });
    state.set('count', 0);
    expect(state.get('count', 99)).toBe(0);
  });

  test('write-through is still the default, so a reopened store sees the value', () => {
    const p = path.join(dir, 'nested-state.json');
    new StateStore({ filePath: p }).set('alertsLastTs', 'ts-1');
    expect(new StateStore({ filePath: p }).get('alertsLastTs', null)).toBe('ts-1');
  });

  test('with a debounce, flush() forces the pending write out', () => {
    const p = path.join(dir, 'debounced-state.json');
    const store = new StateStore({ filePath: p, debounceMs: 5000 });
    store.set('alertsLastTs', 'ts-2');
    expect(fs.existsSync(p)).toBe(false); // still buffered
    store.flush();
    expect(new StateStore({ filePath: p }).get('alertsLastTs', null)).toBe('ts-2');
  });

});