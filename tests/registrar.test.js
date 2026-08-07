'use strict';

const createRegistrar = require('../src/slack/registrar');
const { NEED_START } = require('../src/slack/registrar');
const { UserFacingError } = require('../src/util/errors');

/*
 * The registrar sits in front of every slash command, button and modal in the
 * bot. Everything it does - acking, the "have you run
 * /start" gate, argument counting, error translation - happens to every
 * interaction, so a regression here is a regression everywhere at once
 */

function fakeApp() {
  return { command: jest.fn(), action: jest.fn(), view: jest.fn() };
}

function fakeCtx(user = null) {
  return { users: { get: jest.fn().mockReturnValue(user) } };
}

/** Pull the wrapped handler back out of the fake Bolt app */
const wrappedFrom = (app, kind) => app[kind].mock.calls[0][1];

/** Bolt-shaped args for a slash command invocation */
function commandArgs(text = '', over = {}) {
  const sent = [];
  return {
    sent,
    args: {
      ack: jest.fn().mockResolvedValue(undefined),
      respond: jest.fn(async (msg) => sent.push(msg)),
      command: { text, user_id: 'U1' },
      ...over,
    },
  };
}

describe('registrar: acking', () => {
  test('commands are acked before the handler runs', async () => {
    const app = fakeApp();
    const order = [];
    const { args } = commandArgs();
    args.ack = jest.fn(async () => order.push('ack'));

    createRegistrar(app, fakeCtx()).command('/case', async () => order.push('handler'));
    await wrappedFrom(app, 'command')(args);

    expect(order).toEqual(['ack', 'handler']);
  });

  test('a failed ack stops the handler - Slack has already timed out', async () => {
    const app = fakeApp();
    const handler = jest.fn();
    const { args } = commandArgs();
    args.ack = jest.fn().mockRejectedValue(new Error('too slow'));

    createRegistrar(app, fakeCtx()).command('/case', handler);
    await wrappedFrom(app, 'command')(args);

    expect(handler).not.toHaveBeenCalled();
  });

  test('views are not auto-acked, because they ack with a response_action', async () => {
    const app = fakeApp();
    const ack = jest.fn().mockResolvedValue(undefined);

    createRegistrar(app, fakeCtx()).view('modal', async (a) => {
      expect(ack).not.toHaveBeenCalled(); // handler owns the ack
      await a.ack({ response_action: 'errors', errors: {} });
    });
    await wrappedFrom(app, 'view')({ ack, body: { user: { id: 'U1' } } });

    expect(ack).toHaveBeenCalledWith({ response_action: 'errors', errors: {} });
    expect(ack).toHaveBeenCalledTimes(1); // no second, fallback ack
  });

  test('a view handler that forgets to ack gets one anyway', async () => {
    // Otherwise the modal spins on the analyst's screen until Slack gives up
    const app = fakeApp();
    const ack = jest.fn().mockResolvedValue(undefined);

    createRegistrar(app, fakeCtx()).view('modal', async () => {});
    await wrappedFrom(app, 'view')({ ack, body: { user: { id: 'U1' } } });

    expect(ack).toHaveBeenCalledTimes(1);
  });
});

describe('registrar: gates', () => {
  test('too few arguments shows the usage string instead of calling the handler', async () => {
    const app = fakeApp();
    const handler = jest.fn();
    const { args, sent } = commandArgs('');

    createRegistrar(app, fakeCtx()).command('/add_alert', handler, {
      minArgs: 2,
      usage: 'Usage: `/add_alert <caseID> <alertID>`',
    });
    await wrappedFrom(app, 'command')(args);

    expect(handler).not.toHaveBeenCalled();
    expect(sent[0].text).toContain('/add_alert <caseID> <alertID>');
    expect(sent[0].response_type).toBe('ephemeral');
  });

  test('an unregistered user is sent to /start rather than into the handler', async () => {
    const app = fakeApp();
    const handler = jest.fn();
    const { args, sent } = commandArgs('alert-1');

    createRegistrar(app, fakeCtx(null)).command('/case', handler, { requireUser: true });
    await wrappedFrom(app, 'command')(args);

    expect(handler).not.toHaveBeenCalled();
    expect(sent[0].text).toBe(NEED_START);
  });

  test('a registered user is handed to the handler along with a parsed argv', async () => {
    const app = fakeApp();
    const user = { kibanaUsername: 'jsmith', apiKey: 'k' };
    const handler = jest.fn();
    const { args } = commandArgs('  case-1   alert-1  ');

    createRegistrar(app, fakeCtx(user)).command('/add_alert', handler, {
      requireUser: true,
      minArgs: 2,
    });
    await wrappedFrom(app, 'command')(args);

    const passed = handler.mock.calls[0][0];
    expect(passed.argv).toEqual(['case-1', 'alert-1']); // collapsed whitespace
    expect(passed.user).toBe(user);
    expect(passed.slackUserId).toBe('U1');
    expect(passed.traceId).toEqual(expect.any(String));
  });
});

describe('registrar: replies and errors', () => {
  test('actions reply ephemerally through the web client', async () => {
    // Actions have no `respond`, so the reply surface has to go through chat.*
    const app = fakeApp();
    const client = {
      chat: { postEphemeral: jest.fn().mockResolvedValue({}), postMessage: jest.fn() },
    };

    createRegistrar(app, fakeCtx()).action('btn', async ({ reply }) => reply.ephemeral('hi'));
    await wrappedFrom(app, 'action')({
      ack: jest.fn().mockResolvedValue(undefined),
      client,
      body: { user: { id: 'U1' }, channel: { id: 'C1' } },
    });

    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', user: 'U1', text: 'hi' })
    );
  });

  test('an action with no channel falls back to a DM', async () => {
    const app = fakeApp();
    const client = { chat: { postEphemeral: jest.fn(), postMessage: jest.fn().mockResolvedValue({}) } };

    createRegistrar(app, fakeCtx()).action('btn', async ({ reply }) => reply.ephemeral('hi'));
    await wrappedFrom(app, 'action')({
      ack: jest.fn().mockResolvedValue(undefined),
      client,
      body: { user: { id: 'U1' } },
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'U1', text: 'hi' })
    );
  });

  test('a user-facing error reaches the analyst verbatim', async () => {
    const app = fakeApp();
    const { args, sent } = commandArgs('alert-1');

    createRegistrar(app, fakeCtx()).command('/case', async () => {
      throw new UserFacingError('No alert found with ID `alert-1`.');
    });
    await wrappedFrom(app, 'command')(args);

    expect(sent[0].text).toContain('No alert found with ID');
  });

  test('an unexpected error is swallowed and replaced with a trace id', async () => {
    // The analyst must never see an internal hostname, and Bolt must never see
    // the throw - an unhandled rejection here takes down the interaction
    const app = fakeApp();
    const { args, sent } = commandArgs('alert-1');

    createRegistrar(app, fakeCtx()).command('/case', async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:9200');
    });

    await expect(wrappedFrom(app, 'command')(args)).resolves.toBeUndefined();
    expect(sent[0].text).not.toContain('10.0.0.5');
  });
});