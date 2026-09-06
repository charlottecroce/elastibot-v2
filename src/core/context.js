'use strict';

const config = require('../../config');
const { UserStore, StateStore } = require('./store');
const { getSharedSpaceService } = require('./services/spaceService');
const { logger } = require('./util/logger');

/*
 * The application context: everything with a lifetime longer than one request.
 *
 * WHAT CHANGED: `incidents` is no longer built here. IncidentStore moved to
 * src/features/cases/ with the rest of the incident pipeline, and core requiring
 * it back would be exactly the inverted dependency the eslint boundary exists to
 * stop - core has no idea what an incident is, and should not stop booting
 * because the cases feature was removed.
 *
 * `ctx.incidents` still exists at runtime for every handler and watcher that
 * used it. The cases feature attaches it in its register(), which is the first
 * thing that happens after the context is built. Every existing call site is
 * unchanged; the difference is that with cases disabled there is simply no
 * `ctx.incidents`, and nothing in core is looking for one.
 *
 * Both persisted stores here are write-through. A buffered alert cursor is only
 * ever as good as the last flush, and anything that copies data/ out from under
 * a live process - a backup, a container snapshot - captures a state.json older
 * than what has actually been posted. Restoring that rewinds the cursor onto
 * alerts already in the channel and they get posted twice.
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

  const state = overrides.state || new StateStore({ filePath: config.security.statePath });

  // Shared with whichever feature needs a space name, so a watcher lookup warms
  // the cache for the next /case and vice versa
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

  /*
   * A test that wants a fake incident store can still pass one, and it lands in
   * the same place the cases feature would put it. Kept so the existing watcher
   * and command tests build their context the way they always did.
   */
  if (overrides.incidents) ctx.incidents = overrides.incidents;

  return ctx;
}

module.exports = { createContext };