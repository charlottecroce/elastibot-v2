#!/usr/bin/env node
'use strict';

/*
 * Parse every .js file in the repo with `node --check`.
 *
 * Overlaps with `npm run lint`, but has no dependencies, so it still runs when
 * node_modules is absent or eslint itself is broken
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['node_modules', 'coverage', 'data']);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

const files = walk(process.cwd());
const failures = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failures.push(`${file}\n${err.stderr?.toString().trim() || err.message}`);
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join('\n\n')}\n\nsyntax FAILED: ${failures.length} file(s)\n`);
  process.exit(1);
}

process.stdout.write(`syntax ok: ${files.length} files\n`);