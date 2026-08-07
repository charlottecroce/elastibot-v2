'use strict';

const config = require('../config');
const { UserStore, StateStore } = require('./store');
const { IncidentStore } = require('./incidents');
const { getSharedSpaceService } = require('./services/spaceService');
const { logger } = require('./util/logger');

/*
 * The application context: everything with a lifetime longer than one request.
 *
 * Both persisted stores are write-through. A buffered alert cursor is only ever
 * as good as the last flush, and anything that copies data/ out from under a
 * live process - a backup, a container snapshot - captures a state.json older
 * than what has actually been posted. Restoring that rewinds the cursor onto
 * alerts already in the channel and they get posted twice.
 */

/**
 * @param {object} [overrides] swap in fakes for tests
 * @returns {{users, state, incidents, spaces, log, close}}
 */
function createContext(overrides = {}) {
  const log = logger.child({ scope: 'context' });

  const users =
    overrides.users ||
    new UserStore({
      filePath: config.security.userStorePath,
      encryptionKey: config.security.encryptionKey,
    });

  const state = overrides.state || new StateStore({ filePath: config.security.statePath });

  /*
   * Posted incidents, so a block kit can be updated on a later poll tick and so
   * two analysts can't open two cases for the same burst. A create-case claim
   * that isn't on disk when the process dies is a claim that never existed
   */
  const incidents =
    overrides.incidents ||
    new IncidentStore({
      filePath: config.security.incidentStorePath,
      idleMs: config.incidents.idleMs,
      maxLifetimeMs: config.incidents.maxLifetimeMs,
      claimTtlMs: config.incidents.claimTtlMs,
    });

  // Shared with caseService, so a watcher lookup warms the cache for /case
  const spaces = overrides.spaces || getSharedSpaceService();

  return {
    users,
    state,
    incidents,
    spaces,
    log,

    /** Flush anything buffered and release resources. Safe to call twice */
    async close() {
      try {
        state.flush?.();
        users.flush?.();
        incidents.flush?.();
      } catch (err) {
        log.error('error flushing stores during shutdown', { err });
      }
      // Drop decrypted API keys from memory
      users.clearCache?.();
      spaces.clear?.();
      log.debug('context closed');
    },
  };
}

module.exports = { createContext };