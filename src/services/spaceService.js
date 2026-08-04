'use strict';

const { TtlCache } = require('../util/cache');
const { logger } = require('../util/logger');
const { DEFAULT_SPACE } = require('../constants');

/*
 * Kibana space id > display name, cached.

 * One cache, shared by both, with a TTL so renames are picked up. Keyed on the
 * space id only: the display name is a property of the space, not of whose API
 * key asked for it, so a watcher lookup warms the cache for analysts and vice versa
 */

const log = logger.child({ scope: 'service:space' });

function createSpaceService({ ttlMs = 3600000, max = 200 } = {}) {
  const cache = new TtlCache({ ttlMs, max });

  return {
    /**
     * @param {string} spaceId
     * @param {object} client an Elastic client with getSpaceName(spaceId)
     * @returns {Promise<string>} display name, or the id if lookup fails
     */
    async getName(spaceId, client) {
      const id = spaceId || DEFAULT_SPACE;

      return cache.getOrLoad(id, async () => {
        try {
          const name = await client.getSpaceName(id);
          log.debug('space name resolved', { spaceId: id, name });
          return name || id;
        } catch (err) {
          // Never fail a case creation over a cosmetic lookup. Falling back to
          // the id is what the old client-level catch did; we just log it now
          log.warn('space name lookup failed - falling back to the id', { err, spaceId: id });
          return id;
        }
      });
    },

    /** Force a refresh, e.g. after an operator renames a space */
    invalidate(spaceId) {
      return cache.delete(spaceId);
    },

    clear() {
      cache.clear();
    },

    get size() {
      return cache.size;
    },
  };
}

/*
 * A lazily-created shared instance.
 *
 * The watchers get their space service from the application context, but
 * caseService is called as createCaseForAlert(apiKey, id) - it has no context to
 * reach into without threading one through every service signature. Rather than
 * do that refactor now, both paths resolve to this same instance, so a watcher
 * lookup warms the cache for the next /case and vice versa. It is an in-memory
 * cache with no I/O of its own, so a module-level instance costs nothing at
 * import time - unlike the Elastic service client, which built an HTTP client
 */
let shared = null;

function getSharedSpaceService() {
  if (!shared) {
    // Required lazily so this module has no import-time config dependency
    const config = require('../../config');
    shared = createSpaceService({ ttlMs: config.cache.spaceNameTtlMs });
  }
  return shared;
}

/** Convenience for callers that have a client but no context */
function getSpaceName(spaceId, client) {
  return getSharedSpaceService().getName(spaceId, client);
}

module.exports = { createSpaceService, getSharedSpaceService, getSpaceName };