'use strict';

/*
 * config/loader.js - reads elastibot.yml and resolves each setting.
 *
 * Precedence, highest first:
 *
 *   YAML value  >  environment variable  >  built-in default
 *
 * YAML wins deliberately. The alternative means an
 * operator edits elastibot.yml, restarts, and nothing changes because of a
 * variable they forgot was exported. When both are set we record it in
 * `shadowed` and app.js warns, so the losing side is never silent.
 *
 * Because the file holds credentials, checkPermissions() below refuses to
 * let a group- or world-readable config pass unremarked.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

class ConfigFileError extends Error {}

/**
 * The config file holds the Slack tokens, the Elastic service key and the
 * at-rest encryption key. A world-readable one is a credential leak to every
 * account on the host, and `cp elastibot.example.yml elastibot.yml` inherits
 * the umask, which on most distributions is 0644.
 *
 * @returns {{mode: string, groupReadable: boolean, worldReadable: boolean}|null}
 */
function checkPermissions(filePath) {
  // Windows has no meaningful POSIX mode
  if (!filePath || process.platform === 'win32') return null;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  const bits = stat.mode & 0o777;
  const groupReadable = Boolean(bits & 0o040);
  const worldReadable = Boolean(bits & 0o004);
  if (!groupReadable && !worldReadable) return null;

  return {
    mode: bits.toString(8).padStart(3, '0'),
    groupReadable,
    worldReadable,
  };
}

/** Candidate paths, in order. ELASTIBOT_CONFIG is explicit and must exist */
function resolvePath() {
  const explicit = process.env.ELASTIBOT_CONFIG;
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new ConfigFileError(`ELASTIBOT_CONFIG points at ${explicit}, which does not exist.`);
    }
    return explicit;
  }
  /*
   * A test run must not pick up whatever elastibot.yml happens to be sitting in
   * the working directory - the suite pins its own settings through the
   * environment, and a developer's real config silently overriding them is the
   * kind of failure that only shows up on one machine. ELASTIBOT_CONFIG still
   * works, so a test that wants to exercise the file can point at a fixture
   */
  if (process.env.NODE_ENV === 'test') return null;

  for (const p of ['./elastibot.yml', './elastibot.yaml', './config/elastibot.yml']) {
    const full = path.resolve(process.cwd(), p);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * `elastic.kibana_url: x` at any level becomes `{ elastic: { kibana_url: x } }`.
 * Deep-merges, so a file may mix the two styles freely.
 */
function expandDotted(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node;

  const out = {};
  for (const [rawKey, rawVal] of Object.entries(node)) {
    const value = expandDotted(rawVal);
    const parts = String(rawKey).split('.');
    let cursor = out;

    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (cursor[part] === undefined) cursor[part] = {};
      if (cursor[part] === null || typeof cursor[part] !== 'object') {
        throw new ConfigFileError(
          `${rawKey} conflicts with an earlier setting - "${parts.slice(0, i + 1).join('.')}" ` +
            'is both a value and a section.'
        );
      }
      cursor = cursor[part];
    }

    const leaf = parts[parts.length - 1];
    if (
      cursor[leaf] !== undefined &&
      cursor[leaf] !== null &&
      typeof cursor[leaf] === 'object' &&
      !Array.isArray(cursor[leaf]) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      Object.assign(cursor[leaf], value);
    } else {
      cursor[leaf] = value;
    }
  }
  return out;
}

/*
 * ${VAR} and ${VAR:default}. An unset ${VAR} with no default resolves to
 * undefined rather than throwing: the shipped elastibot.example.yml references
 * every secret this way, and a missing one should be reported by
 * config/validate.js as "SLACK_BOT_TOKEN is required" - which names the thing
 * the operator actually has to go set - not as a parse error from this file.
 */
const INTERP = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g;
const WHOLE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}$/;

function interpolate(node, unresolved, interpolated, trail = []) {
  if (typeof node === 'string') {
    const key = trail.join('.');

    const whole = node.match(WHOLE);
    if (whole) {
      const [, name, dflt] = whole;
      const env = process.env[name];
      if (env !== undefined && env !== '') {
        interpolated.add(key);
        return env;
      }
      if (dflt !== undefined) return dflt;
      unresolved.push({ key, env: name });
      return undefined; // treated as "not set in YAML"
    }

    // Embedded in a larger string, e.g. "https://${ES_HOST}:9200"
    return node.replace(INTERP, (match, name, dflt) => {
      const env = process.env[name];
      if (env !== undefined && env !== '') {
        interpolated.add(key);
        return env;
      }
      if (dflt !== undefined) return dflt;
      unresolved.push({ key, env: name });
      return '';
    });
  }

  if (Array.isArray(node)) {
    return node.map((item, i) => interpolate(item, unresolved, interpolated, [...trail, i]));
  }

  if (node !== null && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const resolved = interpolate(v, unresolved, interpolated, [...trail, k]);
      if (resolved !== undefined) out[k] = resolved;
    }
    return out;
  }

  return node;
}

/** Walk a dotted path. Returns undefined for a missing key OR an explicit null */
function dig(root, dotted) {
  const value = String(dotted)
    .split('.')
    .reduce((node, key) => (node === null || typeof node !== 'object' ? undefined : node[key]), root);
  return value === null ? undefined : value;
}

/**
 * Build the resolver used by config/index.js.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.file] override the search (tests)
 * @returns {{get: function, file: string|null, shadowed: Array, unresolved: Array, raw: object}}
 */
function loadConfigFile({ file } = {}) {
  const filePath = file === undefined ? resolvePath() : file;

  let parsed = {};
  if (filePath) {
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new ConfigFileError(`Could not read ${filePath}: ${err.message}`);
    }
    try {
      parsed = yaml.load(text) || {};
    } catch (err) {
      // js-yaml's message already carries line and column
      throw new ConfigFileError(`${filePath} is not valid YAML.\n${err.message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigFileError(`${filePath} must contain a mapping at the top level.`);
    }
  }

  const unresolved = [];
  /*
   * Keys whose value came from a ${VAR} substitution. These must NOT be
   * reported as shadowing: `bot_token: ${SLACK_BOT_TOKEN}` means "take it from
   * the environment", so warning that SLACK_BOT_TOKEN was overridden by the
   * file would fire for every secret in the shipped example config and teach
   * everyone to ignore the warning that matters
   */
  const interpolated = new Set();
  const tree = interpolate(expandDotted(parsed), unresolved, interpolated);
  const shadowed = [];

  /**
   * Resolve one setting.
   *
   * @param {string} key    dotted path in elastibot.yml, e.g. 'elastic.timeout_ms'
   * @param {string|null} env  env var override, e.g. 'ELASTIC_TIMEOUT_MS'
   * @param {function} coerce (value, label) => value
   * @param {*} dflt
   */
  function get(key, env, coerce, dflt) {
    const fromFile = dig(tree, key);
    const fromEnv = env ? process.env[env] : undefined;
    const envSet = fromEnv !== undefined && fromEnv !== '';

    // Label used in coercion errors. Name whichever source the value came from,
    // because that is the one the operator has to go and fix
    if (fromFile !== undefined) {
      // A couple of settings are read twice (kibana_public_url falls back to
      // kibana_url, naming.timezone to stats.timezone), so dedupe
      if (envSet && !interpolated.has(key) && !shadowed.some((e) => e.key === key && e.env === env)) {
        shadowed.push({ key, env });
      }
      return coerce(fromFile, `${key} (in ${filePath || 'elastibot.yml'})`, dflt);
    }
    if (envSet) return coerce(fromEnv, env, dflt);
    return dflt;
  }

  return {
    get,
    file: filePath,
    shadowed,
    unresolved,
    permissions: checkPermissions(filePath),
    raw: tree,
  };
}

module.exports = {
  loadConfigFile,
  expandDotted,
  interpolate,
  dig,
  checkPermissions,
  ConfigFileError,
};