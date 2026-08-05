'use strict';

const config = require('../config');
const { UserStore, StateStore } = require('./store');
const { getSharedSpaceService } = require('./services/spaceService');
const { logger } = require('./util/logger');

/*
 * The application context: everything with a lifetime longer than one request.
 */

/**
 * @param {object} [overrides] swap in fakes for tests
 * @returns {{users, state, spaces, log, close}}
 */
function createContext(overrides = {}) {
  const log = logger.child({ scope: 'context' });

  const users =
    overrides.users ||
    new UserStore({
      filePath: config.security.userStorePath,
      encryptionKey: config.security.encryptionKey,
    });

  const state =
    overrides.state ||
    new StateStore({
      filePath: config.security.statePath,
      debounceMs: config.security.stateDebounceMs,
    });

  // Shared with caseService, so a watcher lookup warms the cache for /case
  const spaces = overrides.spaces || getSharedSpaceService();

  const ctx = {
    users,
    state,
    spaces,
    log,

    /** Flush anything buffered and release resources. Safe to call twice */
    async close() {
      try {
        state.flush?.();
        users.flush?.();
      } catch (err) {
        log.error('error flushing stores during shutdown', { err });
      }
      // Drop decrypted API keys from memory
      users.clearCache?.();
      spaces.clear?.();
      log.debug('context closed');
    },
  };

  return ctx;
}

module.exports = { createContext };