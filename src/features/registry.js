'use strict';

/*
 * The list of features that ship in the box. Nothing else.
 *
 * This file requires NOTHING, and that is load-bearing. Two different consumers
 * walk this list at two different times:
 *
 *   config/index.js      -> features/config.js -> require('./<dir>/config')
 *   app bootstrap        -> features/index.js  -> require('./<dir>')
 *
 * config/index.js builds its export at require time, so the first path must not
 * touch anything that requires config. That is why the config half of a feature
 * lives in its own file and is required directly here rather than being reached
 * through the descriptor in <dir>/index.js - which does require config, via its
 * services.
 *
 * `defaultEnabled` is what the base ships with. An operator overrides it with
 * `features.<name>.enabled` in elastibot.yml or FEATURE_<NAME>_ENABLED.
 *
 * Adding a feature is one line here plus a folder. There is no codegen and
 * nothing scans the filesystem: a feature that is present on disk but not in
 * this list does not load, which is what makes an in-progress folder harmless.
 */

const FEATURES = Object.freeze([
  Object.freeze({ name: 'cases', dir: 'cases', defaultEnabled: true }),
  Object.freeze({ name: 'stats', dir: 'stats', defaultEnabled: true }),
  Object.freeze({ name: 'sigma', dir: 'sigma', defaultEnabled: true }),
]);

/** Env var an operator sets to turn a feature off, e.g. FEATURE_SIGMA_ENABLED */
function enabledEnvVar(name) {
  return `FEATURE_${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_ENABLED`;
}

/** Dotted key in elastibot.yml, e.g. features.sigma.enabled */
function enabledYamlKey(name) {
  return `features.${name}.enabled`;
}

module.exports = { FEATURES, enabledEnvVar, enabledYamlKey };