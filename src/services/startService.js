'use strict';

const config = require('../../config');
const { describeAxiosError } = require('../util/errors');
const { VIEWS, ACTIONS } = require('../constants');

/*
 * Everything behind /start that isn't Slack registration plumbing:
 *
 *   - startModalView   builds the "Connect to Elastic" modal in its three
 *                       states (method picker hidden / manual / auto)
 *   - methodOption      the radio_buttons option shape, shared by both
 *                       entries in that picker
 *   - provisioningErrorMessage  a friendlier 401/403 message for the
 *                       automatic-provisioning path specifically - the
 *                       credential that failed there is an admin's, not the
 *                       analyst's own
 *   - safeDm            best-effort private DM, never throws
 *   - parseKibanaUsername  pulls the username back out of a view's
 *                       private_metadata
 *
 * Pulled out of commands/start.js so that file stays what a command module is
 * supposed to be: registration only, same as commands/add_alert.js and
 * commands/stats.js use services/caseService.js and services/statsService.js
 */

function methodOption(value) {
  return {
    text: {
      type: 'plain_text',
      text:
        value === 'auto'
          ? 'Create one for me (admin approval needed)'
          : "I'll paste my own key",
    },
    value,
  };
}

/**
 * @param {string} kibanaUsername
 * @param {object} [opts]
 * @param {'manual'|'auto'} [opts.method]
 * @param {boolean} [opts.canAutoProvision] whether this Slack user is allowed
 *   to see/use the "create one for me" option at all
 */
function startModalView(kibanaUsername, { method = 'manual', canAutoProvision = false } = {}) {
  const effectiveMethod = method === 'auto' && canAutoProvision ? 'auto' : 'manual';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'To create cases *under your own username*, Elastibot needs a personal ' +
          'Elastic API key.',
      },
    },
  ];

  if (canAutoProvision) {
    blocks.push({
      type: 'input',
      block_id: 'method_block',
      dispatch_action: true,
      label: { type: 'plain_text', text: 'How do you want to connect?' },
      element: {
        type: 'radio_buttons',
        // Must match the action_id the handler in commands/start.js is
        // registered under (ACTIONS.START_METHOD_SELECT), or Slack has nothing
        // to route the click to, never gets acked in time, and shows the
        // interaction as failed
        action_id: ACTIONS.START_METHOD_SELECT,
        initial_option: methodOption(effectiveMethod),
        options: [methodOption('manual'), methodOption('auto')],
      },
    });
  }

  if (effectiveMethod === 'auto') {
    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            'Elastibot can create a narrowly-scoped API key for you automatically. This needs ' +
            "*an admin's* Elastic credential with permission to create API keys " +
            '(`manage_api_key` or `manage_own_api_key`) - paste it below.\n\n' +
            'It is used *once*, to create your key, and is never stored or logged. ' +
            "The key handed to you is always limited to Elastibot's analyst role " +
            '(read alerts, manage cases), regardless of what the admin credential itself can do.',
        },
      },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'admin_key_block',
        label: { type: 'plain_text', text: "Admin's Elastic API key" },
        element: {
          type: 'plain_text_input',
          action_id: 'admin_key_input',
          placeholder: { type: 'plain_text', text: 'e.g. VnVhQ2ZHY0JDZGJrU29tZUFwaUtleVZhbHVl' },
        },
      }
    );
  } else {
    blocks.push(
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
          placeholder: { type: 'plain_text', text: 'e.g. VnVhQ2ZHY0JDZGJrU29tZUFwaUtleVZhbHVl' },
        },
      }
    );
  }

  blocks.push({
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
  });

  return {
    type: 'modal',
    callback_id: VIEWS.START_SUBMIT,
    // carry the typed username through to the submission/method-switch handlers
    private_metadata: JSON.stringify({ kibanaUsername }),
    title: { type: 'plain_text', text: 'Connect to Elastic' },
    submit: { type: 'plain_text', text: effectiveMethod === 'auto' ? 'Create key' : 'Save key' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

/** A friendlier message than the generic axios translation for 401/403 here -
 *  the credential that failed is an admin's, not the analyst's own */
function provisioningErrorMessage(err) {
  const status = err?.response?.status;
  if (status === 401 || status === 403) {
    return (
      `that admin credential doesn't have permission to create API keys (status ${status}). ` +
      'It needs the `manage_api_key` (or `manage_own_api_key`) cluster privilege in Elasticsearch.'
    );
  }
  return describeAxiosError(err, 'Creating your API key').message;
}

/** Best-effort private DM. A failure here is logged, never thrown - the modal
 *  has already closed by the time this runs on the automatic path */
async function safeDm(client, slackUserId, text, log) {
  try {
    await client.chat.postMessage({ channel: slackUserId, text });
  } catch (err) {
    log.debug('confirmation DM not delivered', { err });
  }
}

function parseKibanaUsername(privateMetadata, log) {
  try {
    return JSON.parse(privateMetadata || '{}').kibanaUsername || '';
  } catch (err) {
    log.warn('malformed modal metadata', { err });
    return '';
  }
}

module.exports = {
  startModalView,
  methodOption,
  provisioningErrorMessage,
  safeDm,
  parseKibanaUsername,
};