'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/*
 * Atomic JSON writes.
 *
 * The stores previously did a plain fs.writeFileSync. That opens the file,
 * truncates it, then writes - so a crash, an OOM kill or a full disk between
 * truncate and write leaves a truncated or empty file on disk.
 *
 * For data/state.json that is worse than it sounds: a corrupt cursor file is
 * silently treated as "no cursor", which makes the watchers re-baseline to now.
 * Every alert between the crash and the restart is never posted. For
 * data/users.json it means every analyst has to re-run /start
 *
 * Write to a temp file in the same directory, fsync it, then rename over the
 * target. rename(2) is atomic within a filesystem, so a reader sees either the
 * whole old file or the whole new one, never a half-written one
 */

/**
 * @param {string} filePath
 * @param {string} data
 * @param {object} [opts]
 * @param {number} [opts.mode] permissions for the final file (default 0o600)
 * @param {boolean} [opts.fsync] fsync before rename (default true)
 */
function writeFileAtomicSync(filePath, data, { mode = 0o600, fsync = true } = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Same directory as the target, so the rename stays within one filesystem
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );

  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, data);
    if (fsync) fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    fs.renameSync(tmp, filePath);

    // The mode we passed to open is masked by umask; make the final state explicit
    fs.chmodSync(filePath, mode);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp file may not exist */
    }
    throw err;
  }

  // Best effort: fsync the directory so the rename itself is durable. Not all
  // platforms allow opening a directory, so failure here is not fatal
  if (fsync && os.platform() !== 'win32') {
    let dirFd;
    try {
      dirFd = fs.openSync(dir, 'r');
      fs.fsyncSync(dirFd);
    } catch {
      /* not supported here */
    } finally {
      if (dirFd !== undefined) {
        try {
          fs.closeSync(dirFd);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** Convenience: pretty-printed JSON, written atomically */
function writeJsonAtomicSync(filePath, obj, opts) {
  writeFileAtomicSync(filePath, JSON.stringify(obj, null, 2), opts);
}

module.exports = { writeFileAtomicSync, writeJsonAtomicSync };