'use strict';

const config = require('../../config');

/*
 * /start (kibana_username)
 *   Opens a modal that explains how to create an Elastic API key and lets the
 *   analyst paste it privately (modal input never lands in channel history).
 *   On submit we store  slackUserId > { kibanaUsername, apiKey }  so future
 *   cases are created under that analyst's identity.
 */

const CALLBACK_ID = 'elastibot_start_submit';

function startModalView(kibanaUsername) {
  return {
    type: 'modal',
    callback_id: CALLBACK_ID,
    // carry the typed username through to the submission handler
    private_metadata: JSON.stringify({ kibanaUsername }),
    title: { type: 'plain_text', text: 'Connect to Elastic' },
    submit: { type: 'plain_text', text: 'Save key' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            'To create cases *under your own username*, Elastibot needs a personal ' +
            'Elastic API key. Follow these steps, then paste the key below.',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '*1.* In Kibana open *Stack Management > API keys* ' +
            '(or *Security > API keys*).\n' +
            '*2.* Click *Create API key*. Name it e.g. `elastibot-' +
            (kibanaUsername || 'you') +
            '`.\n' +
            '*3.* Give it only the privileges you need (read alerts + manage cases).\n' +
            '*4.* Copy the *Encoded* value (a single base64 string).\n' +
            '_Dev Tools alternative:_ `POST /_security/api_key` > copy the `encoded` field.',
        },
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'apikey_block',
        label: { type: 'plain_text', text: 'Encoded Elastic API key' },
        element: {
          type: 'plain_text_input',
          action_id: 'apikey_input',
          placeholder: { type: 'plain_text', text: 'e.g. VnVhQ2ZHY0JDZGJrU...' },
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: ':lock: Your key is stored encrypted at rest and never posted in a channel.',
          },
        ],
      },
    ],
  };
}

module.exports = function registerStart(app, ctx) {
  app.command('/start', async ({ command, ack, client, respond }) => {
    await ack();
    const kibanaUsername = (command.text || '').trim();
    if (!kibanaUsername) {
      await respond({
        response_type: 'ephemeral',
        text: 'Usage: `/start <kibana_username>` - e.g. `/start jsmith`',
      });
      return;
    }
    await client.views.open({
      trigger_id: command.trigger_id,
      view: startModalView(kibanaUsername),
    });
  });

  app.view(CALLBACK_ID, async ({ ack, view, body, client }) => {
    const apiKey = (
      view.state.values.apikey_block.apikey_input.value || ''
    ).trim();

    if (!apiKey) {
      await ack({
        response_action: 'errors',
        errors: { apikey_block: 'Please paste your encoded API key.' },
      });
      return;
    }

    let kibanaUsername = '';
    try {
      kibanaUsername = JSON.parse(view.private_metadata || '{}').kibanaUsername || '';
    } catch {
      /* ignore malformed metadata */
    }

    const slackUserId = body.user.id;
    ctx.users.set(slackUserId, { kibanaUsername, apiKey });
    await ack();

    // Confirm privately via DM
    try {
      await client.chat.postMessage({
        channel: slackUserId,
        text:
          `:white_check_mark: You're connected as *${kibanaUsername || 'your Elastic user'}*. ` +
          'Cases you create with `/case` will be attributed to you.' +
          (config.security.encryptionKey
            ? ''
            : '\n:warning: Note: `ELASTIBOT_SECRET_KEY` is not set, so your key is stored ' +
              'unencrypted. Ask your admin to enable at-rest encryption.'),
      });
    } catch {
      /* DM may fail if the user hasn't opened the app DM; non-fatal */
    }
  });
};

module.exports.startModalView = startModalView;