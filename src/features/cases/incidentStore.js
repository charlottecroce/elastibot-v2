'use strict';

const config = require('../../../config');
const { IncidentStore } = require('./incidents');

/*
 * The one IncidentStore for the process.
 *
 * It used to be built in core's createContext(). It cannot be any more:
 * incidents.js lives in this feature, and core requiring it back is the inverted
 * dependency the eslint boundary exists to stop. Core should not fail to boot
 * because the cases feature was deleted.
 *
 * It is a singleton rather than something the descriptor constructs inline
 * because two things have to get the SAME instance: the alert watcher, which
 * merges into and re-renders incidents it posted on earlier ticks, and the
 * button handlers, which claim against them. If they had separate stores the
 * watcher would post a second message for a burst the buttons already have a
 * case for - which is the bug the store was written to prevent.
 *
 * Lazy, not module-level, so requiring this file has no side effect on disk.
 * The store reads and writes data/incidents.json in its constructor, and the
 * descriptor is required at boot before anything has decided the feature is
 * even enabled.
 *
 * The store's path stays in core's `security` block with the other two data/
 * paths, so an operator relocating the data directory changes three adjacent
 * lines rather than hunting one down inside a feature.
 */

let store = null;

function getIncidentStore() {
  if (!store) {
    store = new IncidentStore({
      filePath: config.security.incidentStorePath,
      idleMs: config.incidents.idleMs,
      maxLifetimeMs: config.incidents.maxLifetimeMs,
      claimTtlMs: config.incidents.claimTtlMs,
    });
  }
  return store;
}

/** Flush and drop it. Called from the feature's close() */
function closeIncidentStore() {
  if (!store) return;
  store.flush?.();
  store = null;
}

module.exports = { getIncidentStore, closeIncidentStore };