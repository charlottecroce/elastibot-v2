'use strict';

/*
 * REQUIRED BY config/index.js AT REQUIRE TIME.
 *
 * Do not require ../../../config here, and do not require anything that does.
 * config/index.js builds its export as a side effect of being required, so a
 * cycle through this file does not fail loudly - it hands somebody a half-built
 * config object, and because tests/setup.js depends on that export existing, the
 * symptom surfaces in the test suite as something with no obvious connection to
 * what you changed.
 *
 * You do not need config here. The `s` you are handed IS the config accessor.
 */

/**
 * @param {function} s  s(yamlKey, ENV_VAR, coerce, default), with the shared
 *   coercers on s.coercers: str, int, num, bool, list, map
 * @returns {object} the top-level config namespaces this feature owns. They are
 *   merged onto the config root, so `{ example: {...} }` becomes config.example.
 *   Claiming a namespace another feature or core already owns throws at boot.
 */
function defaults(s) {
  const { str, int } = s.coercers;

  return {
    example: {
      greeting: s('example.greeting', 'EXAMPLE_GREETING', str, 'hello'),
      limit: s('example.limit', 'EXAMPLE_LIMIT', int, 10),
    },
  };
}

/**
 * Boot-time checks.
 *
 * Push onto the arrays; do not throw. validateConfig collects every problem in
 * the whole app before failing, so an operator fixes one round of mistakes
 * rather than one mistake per restart.
 *
 * This runs even when the feature is disabled, so that a setting which is wrong
 * in the file is reported before somebody switches the feature on and hits it.
 *
 * @param {object} config the fully assembled config
 * @param {{errors: string[], warnings: string[]}} sink
 */
function validate(config, { errors, warnings }) {
  const example = config.example || {};

  if (!Number.isInteger(example.limit) || example.limit <= 0) {
    errors.push(`EXAMPLE_LIMIT must be a positive integer, got ${JSON.stringify(example.limit)}`);
  }
  if (example.limit > 100) {
    warnings.push(`EXAMPLE_LIMIT is ${example.limit}, which will not render in one Slack message`);
  }
}

module.exports = { defaults, validate };