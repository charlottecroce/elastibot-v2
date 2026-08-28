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
 * the process dying at startup.
 *
 */

const execFileAsync = promisify(execFile);
const log = logger.child({ scope: 'sigma:db' });

const NOT_READY =
  'The Sigma database is not set up yet. An admin needs to run `npm run sigma:setup` ' +
  'and then `npm run update-sigmaDB`.';

let prisma = null;

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

  try {
    const { stdout, stderr } = await execFileAsync('npx', ['prisma', ...args], {
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

/** Every rule in the list, keyed by ruleId. Used by /sigma update */
async function getRulesByIds(ruleIds) {
  if (!ruleIds || !ruleIds.length) return new Map();
  const rows = await getClient().sigmaRule.findMany({
    where: { ruleId: { in: [...new Set(ruleIds)] } },
  });
  return new Map(rows.map((row) => [row.ruleId, toRule(row)]));
}

async function getRule(ruleId) {
  return toRule(await getClient().sigmaRule.findUnique({ where: { ruleId } }));
}

/**
 * Keyword search over title and description.
 *
 * SQLite's LIKE is already case-insensitive for ASCII, which is why there is no
 * `mode: 'insensitive'` here - Prisma doesn't support that flag on sqlite
 */
async function searchRules(term, limit) {
  const rows = await getClient().sigmaRule.findMany({
    where: {
      OR: [{ title: { contains: term } }, { description: { contains: term } }],
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

/** Upsert a batch of already-shaped rows. Called only by the sync */
async function upsertRules(rows) {
  const client = getClient();
  for (const row of rows) {
    await client.sigmaRule.upsert({
      where: { ruleId: row.ruleId },
      create: row,
      update: row,
    });
  }
}

/** Drop rules that are no longer in the repo (deleted or renamed upstream) */
async function deleteRulesNotIn(ruleIds) {
  const { count } = await getClient().sigmaRule.deleteMany({
    where: { ruleId: { notIn: [...new Set(ruleIds)] } },
  });
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