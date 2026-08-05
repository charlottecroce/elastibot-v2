'use strict';

/*
 * One wrapper around every Slack entry point.
 *
 * Every invocation gets a traceId that appears on every log line for that
 * interaction and, if something unexpected breaks, in the message the analyst
 * sees - so a report of "it said something went wrong" is one grep away
 */

const { randomUUID } = require('crypto');
const { logger: rootLogger } = require('../util/logger');
const { handleHandlerError } = require('../util/errorHandler');

const NEED_START =
  'You need to connect first. Run `/start <kibana_username>` to register your Elastic API key.';

function newTraceId() {
  return randomUUID().slice(0, 8);
}

/**
 * A uniform reply surface across commands (which have `respond`) and actions
 * (which post through the web client). Handlers shouldn't care which they're in
 */
function makeReply(kind, args) {
  const { respond, client, body } = args;

  // Accept either a plain string or a full Block Kit payload
  const norm = (msg) => (typeof msg === 'string' ? { text: msg } : { ...msg });

  if (kind === 'command' && typeof respond === 'function') {
    return {
      ephemeral: (msg) => respond({ response_type: 'ephemeral', ...norm(msg) }),
      inChannel: (msg) => respond({ response_type: 'in_channel', ...norm(msg) }),
    };
  }

  const userId = body?.user?.id;
  const channelId = body?.channel?.id;

  return {
    ephemeral: (msg) =>
      channelId
        ? client.chat.postEphemeral({ channel: channelId, user: userId, ...norm(msg) })
        : client.chat.postMessage({ channel: userId, ...norm(msg) }),
    inChannel: (msg) => client.chat.postMessage({ channel: channelId || userId, ...norm(msg) }),
  };
}

function slackUserIdFrom(args) {
  return args.command?.user_id || args.body?.user?.id || args.body?.user_id;
}

/**
 * @param {object} app Bolt app
 * @param {object} ctx shared application context ({ users, ... })
 */
module.exports = function createRegistrar(app, ctx) {
  function register(kind, id, handler, opts = {}) {
    const {
      requireUser = false,
      autoAck = kind !== 'view', // views ack with response_action, so they own it
      usage = null,
      minArgs = 0,
      userErrorSuffix = null,
    } = opts;

    const scope = `${kind}${typeof id === 'string' ? `:${id}` : ''}`;

    async function wrapped(args) {
      const traceId = newTraceId();
      const slackUserId = slackUserIdFrom(args);
      const log = rootLogger.child({ scope, traceId, slackUserId });
      const reply = makeReply(kind, args);

      // Views ack themselves, so wrap ack to track whether they got there. An
      // unacked view leaves the modal spinning until Slack times it out
      let acked = false;
      const originalAck = args.ack;
      const trackedAck = async (...ackArgs) => {
        acked = true;
        return originalAck(...ackArgs);
      };

      if (autoAck) {
        try {
          await trackedAck();
        } catch (ackErr) {
          // A failed ack means Slack already timed out; nothing to reply to
          log.error('ack failed', { err: ackErr });
          return;
        }
      }

      const started = Date.now();
      log.debug('handling');

      try {
        const text = (args.command?.text || '').trim();
        const argv = text ? text.split(/\s+/) : [];

        if (usage && argv.length < minArgs) {
          await reply.ephemeral(usage);
          log.debug('usage shown', { argc: argv.length });
          return;
        }

        let user = null;
        if (requireUser) {
          user = ctx.users.get(slackUserId);
          if (!user) {
            await reply.ephemeral(NEED_START);
            log.debug('user not registered');
            return;
          }
        }

        await handler({
          ...args,
          ack: trackedAck,
          ctx,
          log,
          reply,
          traceId,
          slackUserId,
          user,
          text,
          argv,
        });
        log.debug('handled', { ms: Date.now() - started });
      } catch (err) {
        await handleHandlerError(err, { log, reply, traceId, userErrorSuffix });
      } finally {
        if (!acked) {
          try {
            await originalAck();
          } catch (ackErr) {
            log.error('fallback ack failed', { err: ackErr });
          }
        }
      }
    }

    app[kind](id, wrapped);
  }

  return {
    command: (name, handler, opts) => register('command', name, handler, opts),
    action: (id, handler, opts) => register('action', id, handler, opts),
    view: (id, handler, opts) => register('view', id, handler, opts),
  };
};

module.exports.NEED_START = NEED_START;