#!/usr/bin/env node
'use strict';

/*
 * npm run update-sigmaDB
 *
 * Download (or fast-forward) the Sigma rule repository, convert every rule to
 * the Elasticsearch detection-rule format with sigma-cli, and write the lot to
 * one SQLite database.
 *
 * Not a Slack command, on purpose. It clones a large repo, builds a Python
 * virtualenv and runs for minutes - none of which fits inside a slash command,
 * and none of which an analyst should be able to trigger by accident. `/sigma`
 * only ever reads what this produced
 */

const config = require('../config');
const { logger } = require('../src/util/logger');
const db = require('../src/sigma/db');
const { sync } = require('../src/sigma/ingest');

logger.configure(config.logging);

function usage() {
  process.stdout.write(
    'Usage: npm run update-sigmaDB [-- --quiet]\n\n' +
      'Reads its settings from config.sigma (see .env.example):\n' +
      `  repo      ${config.sigma.repoUrl} @ ${config.sigma.repoRef}\n` +
      `  rule dirs ${config.sigma.ruleDirs.join(', ')}\n` +
      `  backend   ${config.sigma.backend} / ${config.sigma.pipeline} / ${config.sigma.format}\n` +
      `  database  ${config.sigma.databaseUrl}\n`
  );
}

/** Single-line progress, only when stdout is a terminal */
function makeProgress(quiet) {
  if (quiet || !process.stdout.isTTY) return undefined;
  return ({ done, total, converted, failed }) => {
    const pct = Math.round((done / total) * 100);
    process.stdout.write(
      `\rconverting ${done}/${total} (${pct}%)  ok=${converted}  failed=${failed}   `
    );
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    usage();
    return;
  }

  const started = Date.now();
  const result = await sync({ onProgress: makeProgress(argv.includes('--quiet')) });
  if (process.stdout.isTTY) process.stdout.write('\n');

  const seconds = Math.round((Date.now() - started) / 1000);
  process.stdout.write(
    `\nSigma database updated in ${seconds}s\n` +
      `  commit    ${result.commit}\n` +
      `  files     ${result.files}\n` +
      `  stored    ${result.ruleCount}\n` +
      `  removed   ${result.removed}\n` +
      `  skipped   ${result.skipped} ` +
      `(${result.failures.length} unsupported, ${result.unidentified.length} with no sigma id, ` +
      `${result.unmatched} unmatched)\n` +
      `  database  ${config.sigma.databaseUrl}\n`
  );

  // The first few are usually enough to spot a systemic problem (a missing
  // plugin, the wrong pipeline) as opposed to a handful of exotic rules
  for (const failure of result.failures.slice(0, 5)) {
    process.stdout.write(`  ! ${failure.file}: ${failure.error.split('\n')[0]}\n`);
  }
  if (result.failures.length > 5) {
    process.stdout.write(`  ! ...and ${result.failures.length - 5} more\n`);
  }
}

main()
  .catch((err) => {
    process.stderr.write(`\nupdate-sigmaDB failed: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.close());