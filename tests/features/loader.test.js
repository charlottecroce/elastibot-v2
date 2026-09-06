'use strict';

const { registerFeatures, bufferingRegistrar, assertDescriptor } = require('../../src/features');

/*
 * The loader sits in front of every feature, so a bug here is a bug in all of
 * them at once - the same reason tests/registrar.test.js exists.
 *
 * Two properties are load-bearing and neither is visible from a feature's own
 * tests:
 *
 *   - a feature whose register() throws is disabled CLEANLY. Not "mostly
 *     disabled with three handlers still live", which is what a plain try/catch
 *     would leave behind, because Bolt has no unregister.
 *   - two features cannot claim the same id. The failure mode without this
 *     check is a click routing to the wrong feature's handler, which produces no
 *     error anywhere.
 */

/** The real registrar's shape, recording instead of registering */
function fakeReg() {
  const calls = [];
  return {
    calls,
    command: (id, handler, opts) => calls.push(['command', id, handler, opts]),
    action: (id, handler, opts) => calls.push(['action', id, handler, opts]),
    view: (id, handler, opts) => calls.push(['view', id, handler, opts]),
  };
}

function feature(name, register, over = {}) {
  return { name, register, ...over };
}

const ctx = {};
const noop = async () => {};

describe('registerFeatures: isolation', () => {
  test('a feature that throws is disabled and the others still register', () => {
    const reg = fakeReg();

    const { registered, failed } = registerFeatures(
      [
        feature('alpha', (r) => r.command('/alpha', noop)),
        feature('boom', () => {
          throw new Error('bad require');
        }),
        feature('omega', (r) => r.command('/omega', noop)),
      ],
      reg,
      ctx
    );

    expect(registered.map((f) => f.name)).toEqual(['alpha', 'omega']);
    expect(failed.map((f) => f.name)).toEqual(['boom']);
    expect(reg.calls.map((c) => c[1])).toEqual(['/alpha', '/omega']);
  });

  test('a feature that throws HALFWAY leaves nothing behind', () => {
    // The reason registration is buffered. Bolt cannot unregister, so anything
    // that reached it before the throw would stay live forever - a feature that
    // is disabled in the logs and half-working in the workspace
    const reg = fakeReg();

    registerFeatures(
      [
        feature('half', (r) => {
          r.command('/half', noop);
          r.action('half:one', noop);
          throw new Error('threw on the third');
        }),
      ],
      reg,
      ctx
    );

    expect(reg.calls).toHaveLength(0);
  });

  test('an id claimed by a feature that then threw is free for the next one', () => {
    const reg = fakeReg();

    const { registered } = registerFeatures(
      [
        feature('first', (r) => {
          r.action('first:go', noop);
          throw new Error('nope');
        }),
        // Same LITERAL id, different feature. Contrived, but it is the case
        // where a stale claim would produce a confusing "already registered by
        // a feature that isn't running" at boot
        feature('first', (r) => r.action('first:go', noop)),
      ],
      reg,
      ctx
    );

    expect(registered).toHaveLength(1);
    expect(reg.calls.map((c) => c[1])).toEqual(['first:go']);
  });

  test('a feature with no register() is still registered, for its watchers', () => {
    const { registered } = registerFeatures([{ name: 'quiet' }], fakeReg(), ctx);
    expect(registered.map((f) => f.name)).toEqual(['quiet']);
  });

  test('handler and options reach the real registrar untouched', () => {
    // The registrar contract is the one thing this refactor does not move
    const reg = fakeReg();
    const handler = async () => {};
    const opts = { requireUser: true, minArgs: 2, usage: 'u', userErrorSuffix: 's', autoAck: false };

    registerFeatures([feature('a', (r) => r.command('/a', handler, opts))], reg, ctx);

    const [, , passedHandler, passedOpts] = reg.calls[0];
    expect(passedHandler).toBe(handler);
    expect(passedOpts).toBe(opts);
  });
});

describe('registerFeatures: id uniqueness', () => {
  test('two features claiming one id is a boot failure for the second, not a silent misroute', () => {
    const reg = fakeReg();

    const { registered, failed } = registerFeatures(
      [
        feature('alpha', (r) => r.action('alpha:go', noop)),
        // Declares alpha's id via its legacy allowlist, so the namespace check
        // passes and only the uniqueness check can catch it
        feature('beta', (r) => r.action('alpha:go', noop), { legacyActionIds: ['alpha:go'] }),
      ],
      reg,
      ctx
    );

    expect(registered.map((f) => f.name)).toEqual(['alpha']);
    expect(failed[0].err.message).toMatch(/already registered by feature "alpha"/);
  });

  test('an un-namespaced action id is refused', () => {
    const { failed } = registerFeatures(
      [feature('alpha', (r) => r.action('go', noop))],
      fakeReg(),
      ctx
    );
    expect(failed[0].err.message).toMatch(/not namespaced/);
  });

  test('an action namespaced under someone else is refused', () => {
    const { failed } = registerFeatures(
      [feature('alpha', (r) => r.action('sigma:page', noop))],
      fakeReg(),
      ctx
    );
    expect(failed[0].err.message).toMatch(/namespaced under another feature/);
  });

  test('commands are exempt - Slack owns the name and it has to match manifest.yml', () => {
    const { failed } = registerFeatures(
      [feature('alpha', (r) => r.command('/alpha', noop))],
      fakeReg(),
      ctx
    );
    expect(failed).toHaveLength(0);
  });

  test('a legacy id is allowed through un-namespaced', () => {
    // An incident message posted before the migration carries the old id in its
    // button payload and sits in a channel indefinitely. The old id has to keep
    // working, and listing it is how that stays a visible, dated decision
    const { failed } = registerFeatures(
      [
        feature('cases', (r) => r.action('create_case_from_alert', noop), {
          legacyActionIds: ['create_case_from_alert'],
        }),
      ],
      fakeReg(),
      ctx
    );
    expect(failed).toHaveLength(0);
  });

  test('a RegExp id is passed through rather than being checked', () => {
    const reg = fakeReg();
    registerFeatures([feature('a', (r) => r.action(/^a:.+$/, noop))], reg, ctx);
    expect(reg.calls).toHaveLength(1);
  });
});

describe('bufferingRegistrar', () => {
  test('records without registering', () => {
    const { reg, pending } = bufferingRegistrar({ name: 'a' }, new Map());
    reg.command('/a', noop);
    reg.action('a:b', noop);

    expect(pending.map(([kind, id]) => `${kind} ${id}`)).toEqual(['command /a', 'action a:b']);
  });
});

describe('assertDescriptor', () => {
  const ok = { name: 'a' };

  test('accepts the minimum: a name', () => {
    expect(() => assertDescriptor(ok, { name: 'a' })).not.toThrow();
  });

  test('catches a name that disagrees with the registry', () => {
    expect(() => assertDescriptor({ name: 'a' }, { name: 'b' })).toThrow(/registered as "b"/);
  });

  test('catches a watcher with no tick', () => {
    expect(() =>
      assertDescriptor({ ...ok, watchers: [{ name: 'w', intervalMs: 1000 }] }, { name: 'a' })
    ).toThrow(/no tick/);
  });

  test('catches a watcher with no interval, which would busy-loop', () => {
    expect(() =>
      assertDescriptor({ ...ok, watchers: [{ name: 'w', tick: noop }] }, { name: 'a' })
    ).toThrow(/positive integer intervalMs/);
  });

  test('catches a register that is not a function', () => {
    expect(() => assertDescriptor({ ...ok, register: {} }, { name: 'a' })).toThrow(/register/);
  });
});