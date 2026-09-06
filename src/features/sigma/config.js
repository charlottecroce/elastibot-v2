'use strict';

const fs = require('fs');

/*
 * /sigma's settings and their boot-time checks.
 *
 * REQUIRED BY config/index.js AT REQUIRE TIME. This file must not require
 * ../../../config, or anything that does, ever. The `s` accessor arrives as an
 * argument for exactly that reason - see src/features/config.js for what the
 * cycle actually breaks.
 *
 * `fs` is fine: it is a node builtin with no config dependency, and the
 * database-exists check was already done with fs rather than by calling
 * sigma/db.isReady(), which would drag config back in through the same door.
 */

/**
 * @param {function} s  s(yamlKey, ENV_VAR, coerce, default)
 * @returns {object} top-level config namespaces this feature owns
 */
function defaults(s) {
  const { str, int, bool, list } = s.coercers;

  return {
    sigma: {
      // --- the rule source ---
      repoUrl: s('sigma.repo_url', 'SIGMA_REPO_URL', str, 'https://github.com/SigmaHQ/sigma.git'),
      repoRef: s('sigma.repo_ref', 'SIGMA_REPO_REF', str, 'master'),
      repoPath: s('sigma.repo_path', 'SIGMA_REPO_PATH', str, './data/sigma-repo'),
      ruleDirs: s('sigma.rule_dirs', 'SIGMA_RULE_DIRS', list, [
        'rules',
        'rules-emerging-threats',
        'rules-threat-hunting',
      ]),

      // --- conversion ---
      venvPath: s('sigma.venv_path', 'SIGMA_VENV_PATH', str, './data/sigvenv'),
      pythonBin: s('sigma.python', 'SIGMA_PYTHON', str, 'python3'),
      backend: s('sigma.backend', 'SIGMA_BACKEND', str, 'lucene'),
      plugin: s('sigma.plugin', 'SIGMA_PLUGIN', str, 'elasticsearch'),
      pipeline: s('sigma.pipeline', 'SIGMA_PIPELINE', str, 'ecs_windows'),
      format: s('sigma.format', 'SIGMA_FORMAT', str, 'siem_rule_ndjson'),
      convertBatchSize: s('sigma.convert_batch', 'SIGMA_CONVERT_BATCH', int, 200),
      commandTimeoutMs: s('sigma.command_timeout_ms', 'SIGMA_COMMAND_TIMEOUT_MS', int, 900000),

      // --- storage ---
      databaseUrl: s(
        'sigma.database_url',
        'SIGMA_DATABASE_URL',
        str,
        `file:${process.cwd()}/data/sigma.db`
      ),

      // --- presentation ---
      pageSize: s('sigma.page_size', 'SIGMA_PAGE_SIZE', int, 10),
      sessionTtlMs: s('sigma.session_ttl_ms', 'SIGMA_SESSION_TTL_MS', int, 900000),
      maxSessions: s('sigma.max_sessions', 'SIGMA_MAX_SESSIONS', int, 200),
      maxSearchResults: s('sigma.max_search_results', 'SIGMA_MAX_SEARCH_RESULTS', int, 200),

      // --- the /sigma update sweep ---
      stackPageSize: s('sigma.stack_page_size', 'SIGMA_STACK_PAGE_SIZE', int, 100),
      maxStackRules: s('sigma.max_stack_rules', 'SIGMA_MAX_STACK_RULES', int, 5000),

      enableNewRules: s('sigma.enable_new_rules', 'SIGMA_ENABLE_NEW_RULES', bool, false),
    },
  };
}

/**
 * Boot-time checks. Pushes onto the shared arrays rather than throwing, so an
 * operator gets every problem in the app at once instead of one per restart.
 *
 * Runs even when the feature is disabled: a setting that is wrong in the file is
 * worth reporting before somebody switches the feature on and hits it.
 */
function validate(config, { errors, warnings }) {
  const sigma = config.sigma || {};

  if (sigma.pageSize < 1 || sigma.pageSize > 20) {
    errors.push(`SIGMA_PAGE_SIZE must be between 1 and 20, got ${JSON.stringify(sigma.pageSize)}`);
  }

  const positiveInt = (value, name) => {
    if (!Number.isInteger(value) || value <= 0) {
      errors.push(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
    }
  };
  positiveInt(sigma.maxStackRules, 'SIGMA_MAX_STACK_RULES');
  positiveInt(sigma.stackPageSize, 'SIGMA_STACK_PAGE_SIZE');

  if (!String(sigma.databaseUrl || '').startsWith('file:')) {
    errors.push(
      `SIGMA_DATABASE_URL must be a sqlite file: url, got ${JSON.stringify(sigma.databaseUrl)}`
    );
  } else if (!fs.existsSync(sigma.databaseUrl.slice('file:'.length))) {
    /*
     * Not fatal - a deployment that never uses /sigma never needs the database,
     * and the command says so itself when asked.
     *
     * Checked with fs rather than by calling src/features/sigma/db.isReady(),
     * which would make this module require config/ transitively.
     */
    warnings.push(
      'the Sigma database does not exist yet - /sigma will tell analysts to ask an admin. ' +
        'Run `npm run sigma:setup` then `npm run update-sigmaDB`'
    );
  }

  if (sigma.enableNewRules) {
    warnings.push(
      'sigma.enable_new_rules is on - rules added by /sigma search will start enabled ' +
        'and begin alerting against index patterns nobody has reviewed'
    );
  }
}

module.exports = { defaults, validate };