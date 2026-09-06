'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeJsonAtomicSync } = require('../src/util/atomicFile');

/*
 * These are about what is on disk after the call, not about the return value.
 * The failed-write test is the one that matters: a truncated data/state.json is
 * silently read back as "no cursor", which re-baselines the watchers to now and
 * loses every alert between the crash and the restart
 */

describe('atomic writes', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('writes the file with restrictive permissions and creates the directory', () => {
    const target = path.join(dir, 'nested', 'state.json');
    writeJsonAtomicSync(target, { cursor: '2026-07-30T12:00:00.000Z' });
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).cursor).toBe('2026-07-30T12:00:00.000Z');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  test('leaves no temp files behind', () => {
    const target = path.join(dir, 'state.json');
    writeJsonAtomicSync(target, { a: 1 });
    writeJsonAtomicSync(target, { a: 2 });
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  test('the previous contents survive a failed write', () => {
    const target = path.join(dir, 'state.json');
    writeJsonAtomicSync(target, { good: true });
    const circular = {}; circular.self = circular;
    expect(() => writeJsonAtomicSync(target, circular)).toThrow();
    // The old file is intact, not truncated - the point of the rename
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ good: true });
  });
});