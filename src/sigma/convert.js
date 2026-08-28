'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { logger } = require('../util/logger');
const { parseNdjson } = require('./parse');

/*
 * sigma-cli: install it into a virtualenv, then convert yaml rules to the
 * Elasticsearch detection-rule shape.
 *
 * ---------------------------------------------------------------------------
 * Plugins and targets are not the same thing
 *
 * `sigma plugin install lucene` fails with "Plugin with identifier lucene not
 * found", because `lucene` is a conversion TARGET. It is provided by the
 * `elasticsearch` PLUGIN (pySigma-backend-elasticsearch), which also provides
 * the eql and esql targets and the ecs_windows pipeline. One plugin, several
 * targets, and the names only coincide for some backends - `splunk` happens to
 * be both, which is what makes the mistake easy to carry around.
 *
 * So the plugin identifier is its own setting, and ensureVenv verifies the
 * TARGET is actually available afterwards rather than trusting the install to
 * have provided it.
 *
 * ---------------------------------------------------------------------------
 * Batching
 *
 * Rules are converted in batches rather than one process per file: a few
 * thousand rules is a few thousand interpreter startups otherwise, and that
 * dominates the runtime.
 *
 * sigma-cli exits non-zero for a whole batch if any rule in it is unsupported
 * by the backend (correlation rules, unsupported modifiers), so a failed batch
 * is retried file-by-file and only the offending rule is lost. That retry is
 * what makes batching safe - but it is also perfectly capable of grinding
 * through several thousand files one at a time when the real problem is that
 * the backend isn't installed, which is why there is a systemic-failure check
 * below. A run that converts nothing must fail loudly, not slowly.
 */

const execFileAsync = promisify(execFile);
const log = logger.child({ scope: 'sigma:convert' });

/** Targets are listed one per row in a table; match the whole word */
function hasTarget(listing, backend) {
  const escaped = String(backend).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])${escaped}([^\\w-]|$)`, 'm').test(listing);
}

async function listTargets(sigmaBin, timeoutMs) {
  const { stdout } = await execFileAsync(sigmaBin, ['list', 'targets'], { timeout: timeoutMs });
  return stdout;
}

/**
 * Create the virtualenv, install sigma-cli and the backend plugin, and confirm
 * the requested target actually exists.
 *
 * The verification is not belt and braces. An existing virtualenv used to be
 * taken as proof that everything in it was installed, so a plugin install that
 * failed once was never retried - the next run skipped straight past it and
 * every conversion failed instead
 *
 * @returns {Promise<{sigmaBin: string, created: boolean, installedPlugin: boolean}>}
 */
async function ensureVenv({ venvPath, pythonBin, backend, plugin, timeoutMs = 600000 }) {
  const dir = path.resolve(process.cwd(), venvPath);
  const sigmaBin = path.join(dir, 'bin', 'sigma');
  const pipBin = path.join(dir, 'bin', 'pip3');
  const opts = { timeout: timeoutMs };
  let created = false;

  if (!fs.existsSync(sigmaBin)) {
    log.info('creating sigma virtualenv', { dir, pythonBin });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await execFileAsync(pythonBin, ['-m', 'venv', dir], opts);
    await execFileAsync(pipBin, ['install', '--upgrade', 'sigma-cli'], opts);
    created = true;
  } else {
    log.info('using existing sigma virtualenv', { dir });
  }

  let targets = await listTargets(sigmaBin, timeoutMs);
  let installedPlugin = false;

  if (!hasTarget(targets, backend)) {
    log.info('installing sigma backend plugin', { plugin, backend });
    try {
      await execFileAsync(sigmaBin, ['plugin', 'install', plugin], opts);
      installedPlugin = true;
    } catch (err) {
      throw new Error(
        `sigma plugin install ${plugin} failed: ${String(err.stderr || err.message).trim()}\n` +
          `Run \`${sigmaBin} plugin list\` to see the available plugin identifiers. ` +
          'Note that a plugin identifier is not the same as a conversion target: ' +
          'the `lucene` target comes from the `elasticsearch` plugin.'
      );
    }
    targets = await listTargets(sigmaBin, timeoutMs);
  }

  if (!hasTarget(targets, backend)) {
    throw new Error(
      `The \`${backend}\` target is not available after installing the \`${plugin}\` plugin.\n\n` +
        `Available targets:\n${targets.trim()}\n\n` +
        'Set sigma.backend to one of those, or set sigma.plugin to the plugin that provides ' +
        `the one you want (\`${sigmaBin} plugin list\`).`
    );
  }

  return { sigmaBin, created, installedPlugin };
}

/** One `sigma convert` invocation over a list of files */
async function convertBatch(files, { sigmaBin, backend, pipeline, format, timeoutMs }) {
  const { stdout } = await execFileAsync(
    sigmaBin,
    ['convert', '-t', backend, '-p', pipeline, '-f', format, ...files],
    { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 }
  );
  return parseNdjson(stdout);
}

/**
 * Convert every file, tolerating individual failures but not universal ones.
 *
 * @returns {Promise<{rules: object[], failures: Array<{file: string, error: string}>}>}
 */
async function convertFiles(files, opts) {
  const { batchSize = 200 } = opts;
  const rules = [];
  const failures = [];

  /*
   * If the first batch produces nothing at all, the problem is the invocation
   * rather than the rules - a missing backend, a pipeline that doesn't exist,
   * a broken virtualenv. Carrying on would mean thousands of subprocesses and
   * then a cheerful "0 rules stored"
   */
  const systemicAfter = Math.min(batchSize, 25);

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);

    try {
      rules.push(...(await convertBatch(batch, opts)));
    } catch {
      // Something in this batch is unsupported - find out which without
      // losing the rest
      for (const file of batch) {
        try {
          rules.push(...(await convertBatch([file], opts)));
        } catch (err) {
          failures.push({ file, error: String(err.stderr || err.message).trim().slice(0, 300) });
        }
      }
    }

    if (!rules.length && failures.length >= systemicAfter) {
      throw new Error(
        `Every one of the first ${failures.length} rules failed to convert, so this is the ` +
          'conversion setup rather than the rules.\n\n' +
          `sigma convert -t ${opts.backend} -p ${opts.pipeline} -f ${opts.format}\n\n` +
          `First error:\n${failures[0].error}\n\n` +
          'Check sigma.backend, sigma.pipeline and sigma.format. Deleting the virtualenv and ' +
          're-running rebuilds it from scratch.'
      );
    }

    opts.onProgress?.({
      done: Math.min(i + batchSize, files.length),
      total: files.length,
      converted: rules.length,
      failed: failures.length,
    });
  }

  return { rules, failures };
}

module.exports = { ensureVenv, convertFiles, hasTarget };