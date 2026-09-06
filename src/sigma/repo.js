'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { logger } = require('../util/logger');

/*
 * The Sigma rule repository on disk: clone it the first time, fast-forward it
 * every time after that.
 *
 * A shallow clone is deliberate. Nothing here needs history, and the full Sigma
 * repo is a lot of objects to carry for a directory of yaml files
 */

const execFileAsync = promisify(execFile);
const log = logger.child({ scope: 'sigma:repo' });

const DEFAULT_TIMEOUT_MS = 600000;

function git(args, opts = {}) {
  return execFileAsync('git', args, { maxBuffer: 32 * 1024 * 1024, ...opts });
}

async function isGitRepo(dir, opts) {
  try {
    await git(['-C', dir, 'rev-parse', '--git-dir'], opts);
    return true;
  } catch {
    return false;
  }
}

async function headCommit(dir, opts) {
  const { stdout } = await git(['-C', dir, 'rev-parse', 'HEAD'], opts);
  return stdout.trim();
}

async function originUrl(dir, opts) {
  try {
    const { stdout } = await git(['-C', dir, 'config', '--get', 'remote.origin.url'], opts);
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Trailing slashes and a `.git` suffix are the same repo, not a different one */
function sameRemote(a, b) {
  const norm = (u) => String(u || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/**
 * Clone or update the repo.
 *
 * @param {object} opts
 * @param {string} opts.repoUrl
 * @param {string} opts.ref       branch or tag
 * @param {string} opts.repoPath  where it lives locally
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{repoPath: string, commit: string, cloned: boolean}>}
 */
async function ensureRepo({ repoUrl, ref, repoPath, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const dir = path.resolve(process.cwd(), repoPath);

  /*
   * Every git call gets the timeout, not just the network ones. A rev-parse
   * against a directory on a wedged NFS mount hangs as thoroughly as a fetch,
   * and a sync that never returns is worse than one that fails
   */
  const opts = { timeout: timeoutMs };

  if (await isGitRepo(dir, opts)) {
    const current = await originUrl(dir, opts);

    if (current && !sameRemote(current, repoUrl)) {
      /*
       * sigma.repo_url was changed under an existing clone. Fetching would
       * quietly keep pulling from the OLD remote and the operator would get
       * rules from a repository they thought they had stopped using
       */
      log.warn('sigma repo url changed - re-cloning', { dir, from: current, to: repoUrl });
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      log.info('updating sigma repo', { dir, ref });
      // Reset rather than pull: a shallow clone with a rewritten upstream branch
      // cannot merge, and nothing local is ever worth keeping here
      await git(['-C', dir, 'fetch', '--depth', '1', 'origin', ref], opts);
      await git(['-C', dir, 'checkout', '-B', ref, 'FETCH_HEAD'], opts);
      await git(['-C', dir, 'reset', '--hard', 'FETCH_HEAD'], opts);
      return { repoPath: dir, commit: await headCommit(dir, opts), cloned: false };
    }
  }

  log.info('cloning sigma repo', { repoUrl, dir, ref });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(['clone', '--depth', '1', '--branch', ref, repoUrl, dir], opts);
  return { repoPath: dir, commit: await headCommit(dir, opts), cloned: true };
}

/**
 * Every .yml/.yaml file under the given subdirectories of the repo.
 *
 * Symlinked directories are skipped rather than followed: `isDirectory()` is
 * false for a symlink, which is what keeps a link back up the tree from turning
 * this walk into an infinite one
 */
function collectRuleFiles(repoPath, ruleDirs) {
  const files = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a configured directory that this repo version doesn't have
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(full);
    }
  };

  for (const sub of ruleDirs) walk(path.join(repoPath, sub));
  return files.sort();
}

module.exports = { ensureRepo, collectRuleFiles, sameRemote };