'use strict';

const config = require('../../../../config');

/*
 * A command and a button that do nothing, wired the way a real one is.
 *
 * Requiring config here IS fine, unlike in ../config.js: this module is reached
 * from the descriptor at boot, long after config/index.js has finished building
 * its export. The rule is about the config LOAD path, not about features
 * generally.
 */

/** Namespaced, and asserted globally unique by the loader at boot */
const ACTIONS = Object.freeze({
  PING: 'example:ping',
});

const USAGE = '*Usage:* `/example [name]`';

module.exports = function registerExample(reg) {
  reg.command(
    '/example',
    async ({ argv, reply, log }) => {
      const who = argv[0] || 'world';

      log.info('example ran', { who });

      await reply.ephemeral({
        text: `${config.example.greeting}, ${who}`,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `${config.example.greeting}, *${who}*` },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                action_id: ACTIONS.PING,
                text: { type: 'plain_text', text: 'Ping' },
                value: who,
              },
            ],
          },
        ],
      });
    },
    {
      requireUser: true,
      usage: USAGE,
      userErrorSuffix: USAGE,
    }
  );

  reg.action(
    ACTIONS.PING,
    async ({ action, reply }) => {
      await reply.ephemeral(`pong, ${action.value}`);
    },
    { requireUser: true }
  );
};

module.exports.ACTIONS = ACTIONS;