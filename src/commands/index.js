'use strict';

const fs = require('fs');
const path = require('path');
const { logger } = require('../util/logger');

/*
 * Command auto-registration.
 *
 * Add a file in src/commands/ that exports `function (reg) { ... }` and it
 * registers itself. Prefix a filename with `_` to keep it out of discovery
 * (helpers that live alongside commands but aren't commands themselves)
 */

const log = logger.child({ scope: 'commands' });

function discover(dir) {
  return fs
    .readdirSync(dir)
    .filter(
      (f) =>
        f.endsWith('.js') &&
        f !== 'index.js' &&
        !f.startsWith('_') &&
        !f.endsWith('.test.js')
    )
    .sort(); // deterministic registration order
}

/**
 * @param {object} reg registrar from src/slack/registrar.js
 * @param {object} [opts]
 * @param {string} [opts.dir] override the command directory (tests)
 * @returns {string[]} names of the modules registered
 */
function registerAll(reg, { dir = __dirname } = {}) {
  const registered = [];

  for (const file of discover(dir)) {
    const name = path.basename(file, '.js');
    // Dynamic require is the point: discovery is what removes the edit-app.js step
    const mod = require(path.join(dir, file));

    if (typeof mod !== 'function') {
      // A command file that exports the wrong shape would otherwise fail
      // silently - the command simply never responds, with nothing in the log
      log.error('command module does not export a register function - skipping', {
        file,
        exported: typeof mod,
      });
      continue;
    }

    mod(reg);
    registered.push(name);
  }

  log.info('commands registered', { count: registered.length, commands: registered });
  return registered;
}

module.exports = { registerAll, discover };