'use strict';

const feature = require('../../src/features/_template');
const { assertDescriptor } = require('../../src/features');

/*
 * The template has a test because the template is the thing people copy. If it
 * ever stops satisfying the contract, every feature written from it that week
 * starts from a broken base.
 *
 * It is also the smallest working example of how to test a feature: build a fake
 * registrar, call register(), and assert on what came back. No Bolt, no Slack.
 */

/** A registrar that records instead of registering */
function fakeReg() {
  const calls = { command: [], action: [], view: [] };
  return {
    calls,
    command: (id, handler, opts) => calls.command.push({ id, handler, opts }),
    action: (id, handler, opts) => calls.action.push({ id, handler, opts }),
    view: (id, handler, opts) => calls.view.push({ id, handler, opts }),
  };
}

const ctx = { users: { get: () => null }, state: {}, incidents: {}, spaces: {} };

describe('the feature template', () => {
  test('satisfies the descriptor contract', () => {
    expect(() => assertDescriptor(feature, { name: 'example' })).not.toThrow();
  });

  test('registers its command and its button', () => {
    const reg = fakeReg();
    feature.register(reg, ctx);

    expect(reg.calls.command.map((c) => c.id)).toEqual(['/example']);
    expect(reg.calls.action.map((c) => c.id)).toEqual(['example:ping']);
  });

  test('every action id it registers is namespaced under its own name', () => {
    // This is the assertion the loader makes at boot. Having it here too means
    // a copied template fails in the unit suite rather than at somebody's deploy
    const reg = fakeReg();
    feature.register(reg, ctx);

    for (const { id } of [...reg.calls.action, ...reg.calls.view]) {
      expect(id.startsWith(`${feature.name}:`)).toBe(true);
    }
  });

  test('contributes a config namespace named after itself', () => {
    const s = (_key, _env, coerce, dflt) => coerce(dflt, 'test');
    s.coercers = {
      str: (v) => String(v),
      int: (v) => Number(v),
      num: (v) => Number(v),
      bool: (v) => Boolean(v),
      list: (v) => v,
      map: (v) => v,
    };

    expect(Object.keys(feature.config.defaults(s))).toEqual(['example']);
  });

  test('its validator reports rather than throws', () => {
    const sink = { errors: [], warnings: [] };
    feature.config.validate({ example: { limit: 0 } }, sink);

    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]).toMatch(/EXAMPLE_LIMIT/);
  });

  test('close() is safe to call without register() ever having run', () => {
    expect(() => feature.close()).not.toThrow();
  });
});