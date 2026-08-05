'use strict';

const config = require('../../config');
const { invalidateClient } = require('../elastic');
const { VIEWS, COMMANDS } = require('../constants');

/*
 * /start (kibana_username)
 *   Opens a modal that explains how to create an Elastic API key and lets the
 *   analyst paste it privately (modal input never lands in channel history).
 *   On submit we store  slackUserId > { kibanaUsername, apiKey }  so future
 *   cases are created under that analyst's identity.
 *
 * The modal submission acks itself - it uses response_action to surface a
 * validation error inside the modal - so it's registered with the view helper,
 * which skips the automatic ack but still wraps the handler in logging and
 * central error handling
 */

function startModalView(kibanaUsername) {
  return {
    type: 'modal',
    callback_id: VIEWS.START_SUBMIT,
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
        // This is the moment the analyst decides whether to trust us with the
        // key, so the claim has to match how the bot is actually configured
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: config.security.encryptionKey
              ? ':lock: Your key is stored encrypted at rest and never posted in a channel.'
              : ':warning: `ELASTIBOT_SECRET_KEY` is not set on this bot, so your key will ' +
                'be stored *unencrypted* on the bot host. It is never posted in a channel.',
          },
        ],
      },
    ],
  };
}

module.exports = function registerStart(reg) {
  reg.command(
    COMMANDS.START,
    async ({ command, client, text, log }) => {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: startModalView(text),
      });
      log.debug('start modal opened');
    },
    {
      usage: 'Usage: `/start <kibana_username>` - e.g. `/start jsmith`',
      minArgs: 1,
    }
  );

  reg.view(VIEWS.START_SUBMIT, async ({ ack, view, client, ctx, slackUserId, log }) => {
    // Slack omits state.values entries for blocks it considers empty
    const apiKey = String(view?.state?.values?.apikey_block?.apikey_input?.value ?? '').trim();

    if (!apiKey) {
      await ack({
        response_action: 'errors',
        errors: { apikey_block: 'Please paste your encoded API key.' },
      });
      log.debug('empty key submitted');
      return;
    }

    let kibanaUsername = '';
    try {
      kibanaUsername = JSON.parse(view.private_metadata || '{}').kibanaUsername || '';
    } catch (err) {
      log.warn('malformed modal metadata - saving without a username', { err });
    }

    const previous = ctx.users.get(slackUserId);
    ctx.users.set(slackUserId, { kibanaUsername, apiKey });

    // Drop the Elastic client built from the key being replaced. Without this a
    // rotated (or revoked) key keeps a working client until ELASTIC_CLIENT_TTL_MS
    if (previous?.apiKey && previous.apiKey !== apiKey) invalidateClient(previous.apiKey);

    await ack();

    // Deliberately does NOT log the key or any part of it
    log.info('analyst registered', {
      kibanaUsername,
      reregistered: Boolean(previous),
      encryptedAtRest: Boolean(config.security.encryptionKey),
    });

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
    } catch (err) {
      // DM may fail if the user hasn't opened the app DM; non-fatal
      log.debug('confirmation DM not delivered', { err });
    }
  });
};

module.exports.startModalView = startModalView;