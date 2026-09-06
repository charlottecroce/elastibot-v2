'use strict';

const { createRunner } = require('../src/watchers/runner');

/*
 * The polling loop, with no polling in it. Three properties a plain
 * setInterval could not give us: a stop() that waits, an overlap guard, and a
 * loop that survives a throwing tick
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('watcher runner', () => {
  test('stop() waits for the tick already in flight', async () => {
    let finished = false;
    const runner = createRunner({
      intervalMs: 10000,
      tick: async () => { await wait(60); finished = true; },
    });

    await wait(10); // let the immediate tick start
    await runner.stop();
    expect(finished).toBe(true); // this is what the old clearInterval could not do
  });

  test('a tick is skipped rather than overlapped', async () => {
    let started = 0;
    const runner = createRunner({
      intervalMs: 20,
      jitterRatio: 0,
      tick: async () => { started += 1; await wait(120); },
    });

    await wait(90);
    await runner.stop();
    expect(started).toBe(1); // several intervals elapsed, none overlapped
  });

  test('a throwing tick does not stop the loop', async () => {
    let calls = 0;
    const runner = createRunner({
      intervalMs: 20,
      jitterRatio: 0,
      tick: async () => { calls += 1; throw new Error('elastic is down'); },
    });

    await wait(90);
    await runner.stop();
    expect(calls).toBeGreaterThan(1);
  });
});