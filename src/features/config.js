'use strict';

const { FEATURES, enabledEnvVar, enabledYamlKey } = require('./registry');

/*
 * Feature-contributed configuration, folded into the one config object.
 *
 * REQUIRED BY config/index.js AT REQUIRE TIME. Everything reachable from here
 * must therefore be free of any dependency on config/ - directly or through a
 * service. Each feature's `config.js` takes the `s` accessor as an ARGUMENT for
 * exactly that reason: a `require('../../config')` anywhere down this path is a
 * cycle, and because config/index.js builds its export as a side effect of being
 * required, the cycle does not fail loudly - it hands somebody a half-built
 * config object. tests/setup.js depends on that export existing, so the symptom
 * lands in the test suite as something unrelated.
 *
 * If you are adding a feature and find yourself wanting config inside
 * config.js: you already have it. It is the `s` you were passed.
 *
 * Each feature's defaults(s) returns a map of TOP-LEVEL namespaces, not a single
 * one, because a feature can legitimately own more than one:
 *
 *   sigma  -> { sigma: {...} }
 *   stats  -> { stats: {...} }
 *   cases  -> { grouping: {...}, incidents: {...}, naming: {...} }
 *
 * Keeping the namespaces flat at the root is deliberate: every existing key path
 * (config.sigma.pageSize, config.grouping.windowMs) survives the move unchanged,
 * so no consumer and no test has to be touched to reorganise the source tree.
 */

/*
 * Namespaces core owns. A feature claiming one of these is a bug that would
 * otherwise silently overwrite half the app's settings, so it throws here rather
 * than being discovered at the first request.
 */
const CORE_NAMESPACES = new Set([
  'source',
  'shutdownTimeoutMs',
  'slack',
  'elastic',
  'security',
  'cache',
  'logging',
  'watchers',
  'features',
]);

/**
 * Build every feature's configuration.
 *
 * @param {function} s the accessor from config/loader.js:
 *   s(yamlKey, ENV_VAR, coerce, default)
 * @param {object} coercers the coercers config/index.js already defines, passed
 *   in so a feature spells its types the same way core does instead of shipping
 *   its own slightly different `bool`
 * @returns {{namespaces: object, features: object}}
 *   namespaces - merge onto the config root
 *   features   - the `features` namespace: { <name>: { enabled } }
 */
function loadFeatureConfig(rawS, coercers) {
  const { bool } = coercers;

  /*
   * The accessor a feature is handed, with the coercers attached to it.
   *
   * They travel WITH `s` rather than as a second parameter so the descriptor
   * contract stays "defaults takes the accessor" and there is no second thing to
   * remember to pass. A feature reaches them as `s.coercers`, which is also the
   * only supported way to get one: a feature defining its own `bool` is how you
   * end up with "yes" being truthy in one namespace and not another.
   */
  const s = Object.assign((...args) => rawS(...args), { coercers: Object.freeze(coercers) });

  const namespaces = {};
  const features = {};
  const owner = new Map(); // namespace -> feature that claimed it

  for (const { name, dir, defaultEnabled } of FEATURES) {
    features[name] = {
      enabled: s(enabledYamlKey(name), enabledEnvVar(name), bool, defaultEnabled),
    };

    // Direct require of the config module, NOT of the descriptor - see header
    // eslint-disable-next-line global-require
    const mod = require(`./${dir}/config`);

    if (typeof mod.defaults !== 'function') {
      throw new Error(
        `features/${dir}/config.js must export defaults(s) - got ${typeof mod.defaults}.`
      );
    }

    /*
     * Defaults are resolved even for a disabled feature. Two reasons: an
     * operator toggling a feature on should not then discover a second round of
     * config errors, and config/validate.js reports on the whole file rather
     * than on whatever happens to be switched on today.
     */
    const contributed = mod.defaults(s) || {};

    for (const [ns, value] of Object.entries(contributed)) {
      if (CORE_NAMESPACES.has(ns)) {
        throw new Error(
          `feature "${name}" tried to define the core config namespace "${ns}". ` +
            'Pick a name of its own, or promote the setting to config/index.js.'
        );
      }
      if (owner.has(ns)) {
        throw new Error(
          `features "${owner.get(ns)}" and "${name}" both define the config namespace ` +
            `"${ns}". Namespaces are global; rename one of them.`
        );
      }
      owner.set(ns, name);
      namespaces[ns] = value;
    }
  }

  return { namespaces, features };
}

/**
 * Run every feature's validate(). Called from config/validate.js, after core's
 * own checks, with the same errors/warnings arrays - so one bad boot still
 * reports every problem at once rather than one per restart.
 *
 * A feature's validator throwing is itself reported as an error rather than
 * being allowed to take the process down: a broken validator should not be a
 * harder failure than the thing it was validating.
 *
 * @param {object} config the assembled config
 * @param {{errors: string[], warnings: string[]}} sink
 */
function validateFeatureConfig(config, { errors, warnings }) {
  for (const { name, dir } of FEATURES) {
    // eslint-disable-next-line global-require
    const mod = require(`./${dir}/config`);
    if (typeof mod.validate !== 'function') continue;

    try {
      mod.validate(config, { errors, warnings });
    } catch (err) {
      errors.push(`feature "${name}" failed to validate its configuration: ${err.message}`);
    }
  }
}

module.exports = { loadFeatureConfig, validateFeatureConfig, CORE_NAMESPACES };