'use strict';

const config = require('../../config');
const db = require('./db');
const { ensureRepo, collectRuleFiles } = require('./repo');
const { ensureVenv, convertFiles } = require('./convert');
const { indexSourceFiles } = require('./parse');
const { contentHash } = require('./ruleDiff');
const { logger } = require('../util/logger');

/*
 * The sync, end to end: fetch the repo, convert everything, write one row per
 * rule.
 *
 * Split from scripts/update-sigma-db.js so the steps stay unit-testable and the
 * script stays argument parsing plus a progress bar
 */

const log = logger.child({ scope: 'sigma:ingest' });

/** A converted rule plus its source file -> a database row */
function toRow(converted, source, { backend, pipeline }) {
  return {
    ruleId: converted.rule_id,
    title: converted.name || source.title || converted.rule_id,
    description: converted.description || '',
    level: source.level,
    status: source.status,
    tags: JSON.stringify(converted.tags || []),
    sourcePath: source.sourcePath,
    sourceHash: source.sourceHash,
    converted: JSON.stringify(converted),
    contentHash: contentHash(converted),
    backend,
    pipeline,
  };
}

/**
 * Run the whole sync.
 *
 * @param {object} [opts]
 * @param {function} [opts.onProgress] called with conversion progress
 * @returns {Promise<object>} summary, also written to the meta row
 */
async function sync({ onProgress } = {}) {
  const { backend, pipeline, format, plugin } = config.sigma;
  const started = Date.now();

  const repo = await ensureRepo({
    repoUrl: config.sigma.repoUrl,
    ref: config.sigma.repoRef,
    repoPath: config.sigma.repoPath,
    timeoutMs: config.sigma.commandTimeoutMs,
  });

  const files = collectRuleFiles(repo.repoPath, config.sigma.ruleDirs);
  log.info('sigma rule files found', { count: files.length, commit: repo.commit });
  if (!files.length) {
    throw new Error(
      `No rule files under ${config.sigma.ruleDirs.join(', ')} in ${repo.repoPath} - ` +
        'check sigma.rule_dirs against the repo layout.'
    );
  }

  // Throws if the requested target isn't available, rather than leaving that to
  // be discovered one failed conversion at a time
  const { sigmaBin } = await ensureVenv({
    venvPath: config.sigma.venvPath,
    pythonBin: config.sigma.pythonBin,
    backend,
    plugin,
    timeoutMs: config.sigma.commandTimeoutMs,
  });

  const { byId, unidentified } = indexSourceFiles(files);

  const { rules, failures } = await convertFiles(files, {
    sigmaBin,
    backend,
    pipeline,
    format,
    batchSize: config.sigma.convertBatchSize,
    timeoutMs: config.sigma.commandTimeoutMs,
    onProgress,
  });

  // A converted rule with no rule_id can't be matched to anything in
  // Elasticsearch later, so it has no use here
  const rows = [];
  let unmatched = 0;
  for (const converted of rules) {
    const source = converted.rule_id ? byId.get(String(converted.rule_id).toLowerCase()) : null;
    if (!source) {
      unmatched += 1;
      continue;
    }
    rows.push(toRow(converted, source, { backend, pipeline }));
  }

  /*
   * Nothing to store means something is wrong, and the database must not be
   * touched. Writing zero rows would otherwise delete every rule from a
   * previously good sync - deleteRulesNotIn([]) is "delete everything" - and
   * the run would report success while /sigma quietly stopped matching anything
   */
  if (!rows.length) {
    throw new Error(
      `Converted ${rules.length} rule(s) from ${files.length} file(s) but none could be stored ` +
        `(${failures.length} failed to convert, ${unidentified.length} had no sigma id, ` +
        `${unmatched} had no matching source file). The database was left untouched.`
    );
  }

  await db.ensureSchema();
  await db.upsertRules(rows);
  const removed = await db.deleteRulesNotIn(rows.map((r) => r.ruleId));

  const summary = {
    repoUrl: config.sigma.repoUrl,
    repoRef: config.sigma.repoRef,
    commit: repo.commit,
    backend,
    pipeline,
    ruleCount: rows.length,
    skipped: failures.length + unidentified.length + unmatched,
    syncedAt: new Date(),
  };
  await db.setMeta(summary);

  log.info('sigma sync complete', {
    ...summary,
    removed,
    conversionFailures: failures.length,
    withoutSigmaId: unidentified.length,
    unmatched,
    ms: Date.now() - started,
  });

  return { ...summary, removed, failures, unidentified, unmatched, files: files.length };
}

module.exports = { sync, toRow };