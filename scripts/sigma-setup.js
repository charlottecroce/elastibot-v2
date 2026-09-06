#!/usr/bin/env node
'use strict';

/*
 * npm run sigma:setup
 *
 * Generates the Prisma client and creates the SQLite file. Run once per host,
 * before the first `npm run update-sigmaDB`.
 *
 */

const config = require('../config');
const { logger } = require('../src/util/logger');
const db = require('../src/sigma/db');

logger.configure(config.logging);

async function main() {
  const url = db.datasourceUrl();
  const file = db.dbFilePath();

  process.stdout.write(`Sigma database: ${url}\n`);
  if (file && String(config.sigma.databaseUrl).slice('file:'.length) !== file) {
    // Worth saying out loud - the operator wrote one path and Prisma is being
    // handed another
    process.stdout.write(`  (resolved from ${config.sigma.databaseUrl})\n`);
  }

  process.stdout.write('\nGenerating the Prisma client...\n');
  await db.generateClient();

  process.stdout.write('Creating the schema...\n');
  await db.ensureSchema();

  process.stdout.write('\nDone. Now run:\n  npm run update-sigmaDB\n');
}

main().catch((err) => {
  process.stderr.write(`\nsigma:setup failed: ${err.message}\n`);
  process.exitCode = 1;
});