'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../../config');
const { UserFacingError } = require('../util/errors');
const { logger } = require('../util/logger');

/*
 * The SigmaDB access layer. This is the ONLY file that knows Prisma exists.
 *
 * Everything else asks for plain objects, so the storage choice stays swappable
 * and the tests never need a generated client.
 *
 * The client is required lazily, not at import time. `@prisma/client` throws if
 * it hasn't been generated yet, and the bot must still boot on a deployment
 * that has never run the sync - `/sigma` then explains what to run instead of
 * the process dying at startup
 */

const execFileAsync = promisify(execFile);
const log = logger.child({ scope: 'sigma:db' });

const NOT_READY =
  'The Sigma database is not set up yet. An admin needs to run `npm run sigma:setup` ' +
  'and then `npm run update-sigmaDB`.';

/*
 * SQLite compiled with the default SQLITE_MAX_VARIABLE_NUMBER caps a statement
 * at 999 host parameters, and a `where: { in: [...] }` spends one per id. Sigma
 * ships several thousand rules and a mature stack has thousands of detection
 * rules, so every list that reaches a query goes through chunk() first
 */
const MAX_SQL_VARS = 900;

/** Rows per write transaction. Big enough to matter, small enough to not lock */
const WRITE_CHUNK = 250;

let prisma = null;

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Sigma ids are UUIDs and case is not meaningful in one, but sigma-cli and
 * Kibana do not always agree on it. Normalising on the way in and on every
 * lookup is what stops a rule silently failing to match itself
 */
function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

/** The datasource url, with any relative `file:` path made absolute */
function datasourceUrl() {
  const url = String(config.sigma.databaseUrl || '');
  if (!url.startsWith('file:')) return url;
  // path.resolve leaves an already-absolute path alone
  return `file:${path.resolve(process.cwd(), url.slice('file:'.length))}`;
}

/** Absolute filesystem path behind the datasource url, or null if it isn't a file */
function dbFilePath() {
  const url = datasourceUrl();
  return url.startsWith('file:') ? url.slice('file:'.length) : null;
}

/** True when the sqlite file exists and the client has been generated */
function isReady() {
  const file = dbFilePath();
  if (file && !fs.existsSync(file)) return false;
  try {
    require.resolve('@prisma/client');
    return true;
  } catch {
    return false;
  }
}

/**
 * The shared PrismaClient.
 *
 * The url is passed explicitly rather than left to the schema, for the same
 * reason runPrisma injects it: the app knows where the file is and Prisma's own
 * env lookup does not
 */
function getClient() {
  if (prisma) return prisma;

  let PrismaClient;
  try {
    ({ PrismaClient } = require('@prisma/client'));
  } catch (err) {
    throw new UserFacingError(NOT_READY, { cause: err });
  }

  prisma = new PrismaClient({
    datasources: { db: { url: datasourceUrl() } },
  });
  return prisma;
}

/**
 * How to invoke the Prisma CLI.
 *
 * The locally installed binary is preferred because bare `npx prisma` will
 * DOWNLOAD prisma on a host that doesn't have it - a slow, silent, network-
 * dependent way to fail on a machine that was only ever meant to run the bot.
 * `--no-install` makes the fallback say so instead
 */
function prismaCli() {
  const binary = process.platform === 'win32' ? 'prisma.cmd' : 'prisma';
  const local = path.resolve(process.cwd(), 'node_modules', '.bin', binary);
  return fs.existsSync(local) ? { cmd: local, prefix: [] } : { cmd: 'npx', prefix: ['--no-install', 'prisma'] };
}

/**
 * Run a Prisma CLI command with the datasource url in its environment.
 *
 * Every CLI invocation in this project goes through here. Calling `prisma`
 * from an npm script instead fails with "Environment variable not found:
 * SIGMA_DATABASE_URL", because the setting lives in elastibot.yml and the CLI
 * cannot read it
 *
 * @param {string[]} args e.g. ['db', 'push', '--skip-generate']
 */
async function runPrisma(args) {
  const env = { ...process.env, SIGMA_DATABASE_URL: datasourceUrl() };
  const { cmd, prefix } = prismaCli();

  try {
    const { stdout, stderr } = await execFileAsync(cmd, [...prefix, ...args], {
      env,
      cwd: process.cwd(),
      timeout: config.sigma.commandTimeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const detail = String(err.stderr || err.stdout || err.message).trim();
    throw new Error(
      `prisma ${args.join(' ')} failed.\n${detail}\n\n` +
        'If this says the prisma command is missing, install dev dependencies ' +
        '(`npm install`) - the CLI is a devDependency and only the generated ' +
        'client is needed at runtime.'
    );
  }
}

/** Generate the client from prisma/schema.prisma */
async function generateClient() {
  log.info('generating prisma client');
  await runPrisma(['generate']);
}

/** Create the sqlite file and tables if they aren't there. Idempotent */
async function ensureSchema() {
  const file = dbFilePath();
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });

  log.info('applying sigma database schema', { url: datasourceUrl() });
  await runPrisma(['db', 'push', '--skip-generate', '--accept-data-loss']);
}

/** Row -> the shape the rest of the app works with */
function toRule(row) {
  if (!row) return null;
  return {
    ruleId: row.ruleId,
    title: row.title,
    description: row.description || '',
    level: row.level || null,
    status: row.status || null,
    tags: JSON.parse(row.tags || '[]'),
    sourcePath: row.sourcePath,
    contentHash: row.contentHash,
    converted: JSON.parse(row.converted),
    updatedAt: row.updatedAt,
  };
}

/**
 * Every rule in the list, keyed by NORMALISED ruleId. Used by /sigma update.
 *
 * Chunked: a space with three thousand Sigma-derived rules would otherwise
 * build a single statement with three thousand host parameters
 */
async function getRulesByIds(ruleIds) {
  const ids = [...new Set((ruleIds || []).map(normalizeId).filter(Boolean))];
  const found = new Map();
  if (!ids.length) return found;

  const client = getClient();
  for (const batch of chunk(ids, MAX_SQL_VARS)) {
    const rows = await client.sigmaRule.findMany({ where: { ruleId: { in: batch } } });
    for (const row of rows) found.set(normalizeId(row.ruleId), toRule(row));
  }
  return found;
}

async function getRule(ruleId) {
  const row = await getClient().sigmaRule.findUnique({ where: { ruleId: normalizeId(ruleId) } });
  return toRule(row);
}

/**
 * `%` and `_` are LIKE wildcards, so a keyword containing one would quietly
 * mean something other than what the analyst typed. Prisma's `contains` gives
 * no way to attach an ESCAPE clause on sqlite, so they are dropped
 */
function likeTerm(term) {
  return String(term || '').trim().replace(/[%_]/g, '').slice(0, 200);
}

/**
 * Keyword search over title and description.
 *
 * SQLite's LIKE is already case-insensitive for ASCII, which is why there is no
 * `mode: 'insensitive'` here - Prisma doesn't support that flag on sqlite
 */
async function searchRules(term, limit) {
  const needle = likeTerm(term);
  if (!needle) return [];

  const rows = await getClient().sigmaRule.findMany({
    where: {
      OR: [{ title: { contains: needle } }, { description: { contains: needle } }],
    },
    orderBy: { title: 'asc' },
    take: limit,
  });
  return rows.map(toRule);
}

async function countRules() {
  return getClient().sigmaRule.count();
}

async function getMeta() {
  return getClient().sigmaMeta.findUnique({ where: { id: 1 } });
}

/**
 * Upsert a batch of already-shaped rows. Called only by the sync.
 *
 * Batched into transactions rather than awaited one at a time: three thousand
 * sequential round trips to a local sqlite file is minutes of wall clock for
 * work that takes seconds
 */
async function upsertRules(rows) {
  if (!rows || !rows.length) return 0;
  const client = getClient();
  let written = 0;

  for (const batch of chunk(rows, WRITE_CHUNK)) {
    await client.$transaction(
      batch.map((row) => {
        const record = { ...row, ruleId: normalizeId(row.ruleId) };
        return client.sigmaRule.upsert({
          where: { ruleId: record.ruleId },
          create: record,
          update: record,
        });
      })
    );
    written += batch.length;
  }

  return written;
}

/**
 * Drop rules that are no longer in the repo (deleted or renamed upstream).
 *
 * Read the ids, diff in memory, delete by `in` - a `notIn` over several
 * thousand ids is both a host-parameter problem and impossible to chunk
 * correctly, since chunking an exclusion turns it into "delete nearly
 * everything" one batch at a time.
 *
 * An empty keep-list is refused rather than obeyed. ingest.js already guards
 * against a zero-row sync, and this is the second lock on the same door: the
 * old `notIn: []` meant "delete every rule you have"
 */
async function deleteRulesNotIn(ruleIds) {
  const keep = new Set((ruleIds || []).map(normalizeId).filter(Boolean));
  if (!keep.size) {
    throw new Error('deleteRulesNotIn was given no ids - refusing to empty the rule table.');
  }

  const client = getClient();
  const existing = await client.sigmaRule.findMany({ select: { ruleId: true } });
  const doomed = existing.map((r) => r.ruleId).filter((id) => !keep.has(normalizeId(id)));

  let count = 0;
  for (const batch of chunk(doomed, MAX_SQL_VARS)) {
    const { count: n } = await client.sigmaRule.deleteMany({ where: { ruleId: { in: batch } } });
    count += n;
  }
  return count;
}

async function setMeta(meta) {
  const client = getClient();
  const row = { id: 1, ...meta };
  await client.sigmaMeta.upsert({ where: { id: 1 }, create: row, update: row });
}

async function close() {
  // Cleared before the await, not after. Otherwise a second close() racing the
  // first sees a live client that is already disconnecting, and a getClient()
  // in between hands out a connection about to be torn down
  const client = prisma;
  prisma = null;
  if (client) await client.$disconnect();
}

module.exports = {
  NOT_READY,
  datasourceUrl,
  dbFilePath,
  isReady,
  normalizeId,
  runPrisma,
  generateClient,
  ensureSchema,
  getClient,
  getRule,
  getRulesByIds,
  searchRules,
  countRules,
  getMeta,
  setMeta,
  upsertRules,
  deleteRulesNotIn,
  close,
};