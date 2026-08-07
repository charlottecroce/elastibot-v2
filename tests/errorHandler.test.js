'use strict';

const {
  safeReply,
  registerBoltErrorHandler,
  registerProcessHandlers,
} = require('../src/util/errorHandler');
const { createLogger } = require('../src/util/logger');

/*
 * process.on and process.exit are stubbed rather than really registered:
 * installing real handlers inside Jest leaks across test files and a real
 * process.exit(1) would take the runner with it.
 *
 * That same reasoning applies to the `hardExit` setTimeout inside
 * registerProcessHandlers' uncaughtException handler: it calls the REAL
 * process.exit(1) after exitTimeoutMs (5s by default). Mocking process.exit to
 * a no-op stops the process from actually terminating, which means that timer
 * is never cancelled the way it would be in production (a real process.exit
 * cancels all pending timers instantly). Left alone, it fires for real several
 * seconds later - well after this test has finished and process.exit has been
 * restored - and kills whatever test happens to be running at that moment.
 *
 * Fake timers for the tests that trigger this handler, so that setTimeout is
 * never real to begin with.
 */

function capturing(level = 'trace') {
  const records = [];
  return { log: createLogger({ sink: (r) => records.push(r), level }), records };
}

/** Register the process handlers against a stub and return them by event name */
function captureProcessHandlers(opts = {}) {
  const handlers = {};
  const onSpy = jest.spyOn(process, 'on').mockImplementation((event, fn) => {
    handlers[event] = fn;
    return process;
  });

  const { log, records } = capturing();
  registerProcessHandlers({ log, ...opts });
  onSpy.mockRestore();

  return { handlers, records };
}

describe('safeReply', () => {
  test('a broken reply path is logged instead of throwing a second error', async () => {
    const { log, records } = capturing();
    const reply = { ephemeral: jest.fn().mockRejectedValue(new Error('slack is down')) };

    await expect(safeReply(reply, 'anything', log)).resolves.toBeUndefined();
    expect(records.some((r) => r.msg.includes('failed to deliver'))).toBe(true);
  });

  test('a missing or malformed reply surface is a no-op', async () => {
    // Some Bolt entry points have no reply path at all
    await expect(safeReply(null, 'x')).resolves.toBeUndefined();
    await expect(safeReply({}, 'x')).resolves.toBeUndefined();
  });
});

describe('registerBoltErrorHandler', () => {
  test('anything escaping our wrappers is logged, not rethrown', async () => {
    const { log, records } = capturing();
    let registered;
    const app = { error: (fn) => { registered = fn; } };

    registerBoltErrorHandler(app, log);
    await expect(registered(new Error('middleware blew up'))).resolves.toBeUndefined();

    expect(records[0].level).toBe('error');
    expect(records[0].err.message).toContain('middleware blew up');
  });
});

describe('registerProcessHandlers', () => {
  test('an unhandled rejection is logged and survived', async () => {
    // One dropped promise in a watcher tick must not end the shift
    const { handlers, records } = captureProcessHandlers();

    handlers.unhandledRejection(new Error('a dropped promise'));

    expect(records[0].level).toBe('error');
    expect(records[0].err.message).toBe('a dropped promise');
  });

  test('a non-Error rejection reason is still serialized usefully', async () => {
    // `Promise.reject('nope')` is legal and used to produce an empty log line
    const { handlers, records } = captureProcessHandlers();

    handlers.unhandledRejection('nope');

    expect(records[0].err.message).toBe('nope');
  });

  test('node warnings are recorded at debug, by shape only', () => {
    const { handlers, records } = captureProcessHandlers();

    handlers.warning({ name: 'MaxListenersExceededWarning', message: '11 listeners added' });

    expect(records[0].level).toBe('debug');
    expect(records[0].name).toBe('MaxListenersExceededWarning');
  });

  /*
   * The four tests below all trigger the uncaughtException handler, which
   * schedules a real `hardExit` setTimeout calling the real process.exit(1).
   * Fake timers keep that setTimeout from ever touching the real event loop,
   * and afterEach guarantees real timers are back even if an assertion throws
   * partway through - a stray fake-timer test must never bleed into the next
   * file's real timers either
   */
  describe('uncaughtException (fake timers)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      // Drain anything still pending under fake control before switching back,
      // so nothing is left to "fire" for real once real timers return
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    test('an uncaught exception runs the cleanup hook and then exits', async () => {
      const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
      const onFatal = jest.fn().mockResolvedValue(undefined);
      const { handlers, records } = captureProcessHandlers({ onFatal });

      handlers.uncaughtException(new Error('state is no longer trustworthy'));
      // Let the onFatal promise chain settle without advancing real time -
      // it resolves via microtasks, not the hardExit timer
      await Promise.resolve();
      await Promise.resolve();

      expect(records[0].level).toBe('fatal');
      expect(onFatal).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      exit.mockRestore();
    });

    test('a cleanup hook that itself throws does not prevent the exit', async () => {
      // Otherwise a broken shutdown hook turns a crash into a hang
      const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
      const onFatal = jest.fn().mockRejectedValue(new Error('flush failed'));
      const { handlers, records } = captureProcessHandlers({ onFatal });

      handlers.uncaughtException(new Error('boom'));
      await Promise.resolve();
      await Promise.resolve();

      expect(records.some((r) => r.msg.includes('cleanup failed'))).toBe(true);
      expect(exit).toHaveBeenCalledWith(1);
      exit.mockRestore();
    });

    test('a second uncaught exception does not start a second shutdown', async () => {
      const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
      const onFatal = jest.fn().mockResolvedValue(undefined);
      const { handlers } = captureProcessHandlers({ onFatal });

      handlers.uncaughtException(new Error('first'));
      handlers.uncaughtException(new Error('second'));
      await Promise.resolve();
      await Promise.resolve();

      expect(onFatal).toHaveBeenCalledTimes(1);
      exit.mockRestore();
    });
  });
});