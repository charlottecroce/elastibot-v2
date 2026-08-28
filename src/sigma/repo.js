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

function git(args, opts = {}) {
  return execFileAsync('git', args, { maxBuffer: 32 * 1024 * 1024, ...opts });
}

async function isGitRepo(dir) {
  try {
    await git(['-C', dir, 'rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

async function headCommit(dir) {
  const { stdout } = await git(['-C', dir, 'rev-parse', 'HEAD']);
  return stdout.trim();
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
async function ensureRepo({ repoUrl, ref, repoPath, timeoutMs = 600000 }) {
  const dir = path.resolve(process.cwd(), repoPath);
  const opts = { timeout: timeoutMs };

  if (await isGitRepo(dir)) {
    log.info('updating sigma repo', { dir, ref });
    // Reset rather than pull: a shallow clone with a rewritten upstream branch
    // cannot merge, and nothing local is ever worth keeping here
    await git(['-C', dir, 'fetch', '--depth', '1', 'origin', ref], opts);
    await git(['-C', dir, 'checkout', '-B', ref, 'FETCH_HEAD'], opts);
    await git(['-C', dir, 'reset', '--hard', 'FETCH_HEAD'], opts);
    return { repoPath: dir, commit: await headCommit(dir), cloned: false };
  }

  log.info('cloning sigma repo', { repoUrl, dir, ref });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(['clone', '--depth', '1', '--branch', ref, repoUrl, dir], opts);
  return { repoPath: dir, commit: await headCommit(dir), cloned: true };
}

/** Every .yml/.yaml file under the given subdirectories of the repo */
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
      else if (/\.ya?ml$/i.test(entry.name)) files.push(full);
    }
  };

  for (const sub of ruleDirs) walk(path.join(repoPath, sub));
  return files.sort();
}

module.exports = { ensureRepo, collectRuleFiles };