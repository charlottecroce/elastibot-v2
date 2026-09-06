'use strict';

const { FEATURES } = require('./registry');
const { createRunner } = require('../core/watchers/runner');
const { logger } = require('../core/util/logger');

/*
 * The feature loader.
 *
 * A feature is a folder under src/features/ that exports a descriptor:
 *
 *   {
 *     name,                                  // must match its registry entry
 *     enabled(config),                       // boolean
 *     config: { defaults(s), validate(cfg, sink) },
 *     register(reg, ctx),                    // commands, actions, views
 *     watchers: [{ name, intervalMs, tick }],
 *     close(),                               // best effort, on shutdown
 *     legacyActionIds: []                    // optional, see below
 *   }
 *
 * Everything except `name` is optional. A feature that only contributes config,
 * or only a watcher, is a legal feature.
 *
 * The two properties this file exists to guarantee:
 *
 *   1. ONE BROKEN CONTRIBUTION DOES NOT GROUND THE BOT. A feature whose
 *      register() throws is logged, disabled, and skipped, and the other
 *      features come up. Registration is buffered and committed only on success,
 *      so a feature that registered three handlers and then threw on the fourth
 *      leaves nothing half-wired behind it - which a straight try/catch around
 *      register() would not give you, because Bolt has no way to unregister.
 *
 *   2. TWO FEATURES CANNOT COLLIDE. Action ids and view callback ids are
 *      namespaced per feature ("sigma:page") and asserted globally unique at the
 *      moment they are registered, so the failure is at boot with both offenders
 *      named, not in production as a click that routes to the wrong handler.
 *
 * Features may depend on core. Features may not depend on each other; that is
 * enforced by eslint no-restricted-imports rather than here, because an import
 * cycle is a lint-time fact and a loader has no business being the thing that
 * notices it.
 */

const log = logger.child({ scope: 'features' });

/** Namespaced ids are "<feature>:<something>" */
const NAMESPACED = /^[a-z0-9_]+:[a-z0-9_:.-]+$/i;

/**
 * Read every descriptor and decide which ones run.
 *
 * A descriptor that fails to load at all - a syntax error, a bad require - is
 * reported and skipped for the same reason a failed register() is: a feature
 * nobody has enabled yet should not be able to stop the bot from booting.
 *
 * @param {object} config
 * @returns {{enabled: object[], disabled: Array<{name, reason}>}}
 */
function loadFeatures(config) {
  const enabled = [];
  const disabled = [];

  for (const entry of FEATURES) {
    let feature;
    try {
      // eslint-disable-next-line global-require
      feature = require(`./${entry.dir}`);
    } catch (err) {
      log.error('feature failed to load - skipping', { feature: entry.name, err });
      disabled.push({ name: entry.name, reason: 'load failed' });
      continue;
    }

    try {
      assertDescriptor(feature, entry);
    } catch (err) {
      log.error('feature descriptor is malformed - skipping', { feature: entry.name, err });
      disabled.push({ name: entry.name, reason: 'malformed descriptor' });
      continue;
    }

    let on;
    try {
      on = feature.enabled ? Boolean(feature.enabled(config)) : true;
    } catch (err) {
      // A feature that cannot decide whether it is on is off
      log.error('feature enabled() threw - treating as disabled', { feature: entry.name, err });
      disabled.push({ name: entry.name, reason: 'enabled() threw' });
      continue;
    }

    if (!on) {
      log.info('feature disabled', { feature: entry.name });
      disabled.push({ name: entry.name, reason: 'disabled by config' });
      continue;
    }

    enabled.push(feature);
  }

  return { enabled, disabled };
}

/** Shape checks worth doing once, at boot, with the feature named */
function assertDescriptor(feature, entry) {
  if (!feature || typeof feature !== 'object') {
    throw new Error(`expected an object, got ${typeof feature}`);
  }
  if (feature.name !== entry.name) {
    throw new Error(`declares name "${feature.name}" but is registered as "${entry.name}"`);
  }
  for (const fn of ['enabled', 'register', 'close']) {
    if (feature[fn] !== undefined && typeof feature[fn] !== 'function') {
      throw new Error(`${fn} must be a function, got ${typeof feature[fn]}`);
    }
  }
  if (feature.watchers !== undefined && !Array.isArray(feature.watchers)) {
    throw new Error(`watchers must be an array, got ${typeof feature.watchers}`);
  }
  for (const w of feature.watchers || []) {
    if (!w || typeof w.tick !== 'function') {
      throw new Error(`watcher "${w?.name || '?'}" has no tick function`);
    }
    if (!Number.isInteger(w.intervalMs) || w.intervalMs <= 0) {
      throw new Error(`watcher "${w.name}" needs a positive integer intervalMs`);
    }
  }
}

/**
 * A registrar that records what a feature registers instead of registering it.
 *
 * The handler and the options are forwarded untouched - this wrapper knows
 * nothing about requireUser, usage, minArgs, userErrorSuffix or autoAck and must
 * never learn: the registrar's contract is the one thing in this refactor that
 * does not move.
 *
 * @param {object} feature the descriptor
 * @param {Map} claimed  id -> feature name, shared across every feature
 */
function bufferingRegistrar(feature, claimed) {
  const pending = [];
  const legacy = new Set(feature.legacyActionIds || []);

  function claim(kind, id) {
    if (typeof id !== 'string') return; // Bolt accepts a RegExp; uniqueness is meaningless then

    const existing = claimed.get(id);
    if (existing) {
      throw new Error(
        `${kind} id "${id}" is already registered by feature "${existing}". ` +
          'Ids are global across the whole Slack app; namespace it.'
      );
    }

    /*
     * Commands are exempt: "/sigma" is a Slack-side identifier that has to match
     * manifest.yml, so it cannot carry a namespace prefix.
     *
     * legacyActionIds is the escape hatch for an id that is already live in a
     * Slack message somewhere. An incident message posted before this refactor
     * carries "create_case_from_alert" in its button payload forever, and those
     * messages sit in a channel indefinitely - so the old id has to keep working
     * alongside the new one for at least a release. Listing it here is a
     * deliberate, visible act with a date on it in the commit, which is the
     * point; the alternative is quietly relaxing the rule for everyone.
     */
    if (kind !== 'command' && !legacy.has(id) && !NAMESPACED.test(id)) {
      throw new Error(
        `${kind} id "${id}" is not namespaced. Use "${feature.name}:${id}", or list it in ` +
          `the feature's legacyActionIds if it is already live in a posted message.`
      );
    }
    if (kind !== 'command' && !legacy.has(id) && !id.startsWith(`${feature.name}:`)) {
      throw new Error(
        `${kind} id "${id}" is namespaced under another feature. ` +
          `Feature "${feature.name}" must use the "${feature.name}:" prefix.`
      );
    }

    claimed.set(id, feature.name);
  }

  return {
    reg: {
      command: (id, handler, opts) => {
        claim('command', id);
        pending.push(['command', id, handler, opts]);
      },
      action: (id, handler, opts) => {
        claim('action', id);
        pending.push(['action', id, handler, opts]);
      },
      view: (id, handler, opts) => {
        claim('view', id);
        pending.push(['view', id, handler, opts]);
      },
    },
    pending,
    /** Undo the id claims of a feature whose register() threw */
    rollback() {
      for (const [, id] of pending) {
        if (typeof id === 'string' && claimed.get(id) === feature.name) claimed.delete(id);
      }
      // A feature can also throw AFTER claiming an id it never got to push
      for (const [id, owner] of [...claimed.entries()]) {
        if (owner === feature.name && !pending.some(([, pid]) => pid === id)) claimed.delete(id);
      }
    },
  };
}

/**
 * Register every enabled feature.
 *
 * @param {object[]} features from loadFeatures().enabled
 * @param {object} reg the real registrar (src/core/slack/registrar.js)
 * @param {object} ctx the application context
 * @returns {{registered: object[], failed: Array<{name, err}>}} the registered
 *   descriptors, which is what should be handed to startFeatureWatchers and
 *   closeFeatures - a feature that failed to register does not get to run a
 *   watcher either
 */
function registerFeatures(features, reg, ctx) {
  const claimed = new Map();
  const registered = [];
  const failed = [];

  for (const feature of features) {
    if (typeof feature.register !== 'function') {
      registered.push(feature);
      continue;
    }

    const buffer = bufferingRegistrar(feature, claimed);

    try {
      feature.register(buffer.reg, ctx);
    } catch (err) {
      buffer.rollback();
      /*
       * The whole point of the buffer: nothing this feature asked for has
       * reached Bolt yet, so "disabled" really means disabled rather than
       * "half of it is live and the other half isn't".
       */
      log.error('feature register() threw - the feature is disabled, the bot is not', {
        feature: feature.name,
        err,
      });
      failed.push({ name: feature.name, err });
      continue;
    }

    // Commit. Nothing below can throw for a reason the feature is responsible
    // for, but if Bolt itself rejects an id the feature still owns the failure
    try {
      for (const [kind, id, handler, opts] of buffer.pending) reg[kind](id, handler, opts);
    } catch (err) {
      log.error('feature failed while attaching handlers - the feature is disabled', {
        feature: feature.name,
        err,
      });
      failed.push({ name: feature.name, err });
      continue;
    }

    registered.push(feature);
    log.info('feature registered', {
      feature: feature.name,
      commands: buffer.pending.filter(([k]) => k === 'command').length,
      actions: buffer.pending.filter(([k]) => k === 'action').length,
      views: buffer.pending.filter(([k]) => k === 'view').length,
    });
  }

  log.info('features ready', {
    registered: registered.map((f) => f.name),
    failed: failed.map((f) => f.name),
    ids: claimed.size,
  });

  return { registered, failed };
}

/**
 * Start one runner per contributed watcher.
 *
 * One runner each rather than one shared tick, because two watchers with
 * different intervals is the normal case and interleaving them into a single
 * tick means the slower one dictates the faster one's floor. The runner's
 * existing overlap guard is per-runner, so a slow tick still cannot stack up
 * behind itself.
 *
 * A watcher tick is called with the application context plus `slack`, which is
 * why this runs after app.start(): a tick that posts needs a live client.
 *
 * @returns {{stop: function(): Promise<void>, isRunning: function(): boolean}}
 */
function startFeatureWatchers(features, ctx, { slack }) {
  const watcherCtx = { ...ctx, slack };
  const runners = [];

  for (const feature of features) {
    for (const spec of feature.watchers || []) {
      const name = `${feature.name}:${spec.name}`;
      runners.push(
        createRunner({
          name,
          intervalMs: spec.intervalMs,
          jitterRatio: spec.jitterRatio,
          tick: () => spec.tick(watcherCtx),
        })
      );
      log.info('watcher started', { watcher: name, intervalMs: spec.intervalMs });
    }
  }

  if (!runners.length) log.info('no feature watchers to start');

  return {
    async stop() {
      await Promise.all(runners.map((r) => r.stop()));
    },
    isRunning: () => runners.some((r) => r.isRunning()),
  };
}

/** Best-effort close, in reverse registration order. Never throws */
async function closeFeatures(features) {
  for (const feature of [...features].reverse()) {
    if (typeof feature.close !== 'function') continue;
    try {
      await feature.close();
    } catch (err) {
      log.error('feature close() failed', { feature: feature.name, err });
    }
  }
}

module.exports = {
  loadFeatures,
  registerFeatures,
  startFeatureWatchers,
  closeFeatures,
  // exported for tests
  bufferingRegistrar,
  assertDescriptor,
};