'use strict';

const config = require('../../config');
const { invalidateClient, provisionAnalystApiKey } = require('../elastic');
const { describeAxiosError } = require('../util/errors');
const { VIEWS, COMMANDS, ACTIONS } = require('../constants');

/*
 * /start (kibana_username)
 *   Opens a modal offering two ways to connect an Elastic API key:
 *
 *   1. PASTE ONE YOURSELF (default, always available) - the modal explains how
 *      to create a key in Kibana and lets the analyst paste it privately.
 *
 *   2. CREATE ONE FOR ME - Elastibot calls POST /_security/api_key itself,
 *      using an admin-supplied credential the analyst pastes in for that one
 *      request only. Like a UAC prompt: the analyst's own Slack identity never
 *      gains any privilege from this, the admin credential is never stored,
 *      cached, or logged, and the key handed back is always restricted to
 *      config.elastic.analystRoleDescriptors regardless of what the admin
 *      credential itself is allowed to do. Only offered to Slack users listed
 *      in config.security.autoProvisionSlackIds - empty by default, meaning
 *      nobody sees it until an operator opts specific people in
 *
 * The modal submission acks itself - it uses response_action to surface a
 * validation error inside the modal - so it's registered with the view helper,
 * which skips the automatic ack but still wraps the handler in logging and
 * central error handling. Creating a key via the automatic path is a network
 * round trip to Elastic, which can run past Slack's ~3s view-submission ack
 * window, so that path acks immediately and reports success/failure by DM
 * instead of via response_action
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
        action_id: 'method_select',
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

module.exports = function registerStart(reg) {
  reg.command(
    COMMANDS.START,
    async ({ command, client, text, slackUserId, log }) => {
      const canAutoProvision = config.security.autoProvisionSlackIds.includes(slackUserId);

      await client.views.open({
        trigger_id: command.trigger_id,
        view: startModalView(text, { method: 'manual', canAutoProvision }),
      });
      log.debug('start modal opened', { canAutoProvision });
    },
    {
      usage: 'Usage: `/start <kibana_username>` - e.g. `/start jsmith`',
      minArgs: 1,
    }
  );

  /*
   * Radio toggle between the two connection methods. Swaps the modal's blocks
   * in place via views.update. If this fires at all, canAutoProvision was
   * already true when the modal was opened
   */
  reg.action(
    ACTIONS.START_METHOD_SELECT,
    async ({ body, client, log }) => {
      const method = body.actions?.[0]?.selected_option?.value === 'auto' ? 'auto' : 'manual';
      const kibanaUsername = parseKibanaUsername(body.view?.private_metadata, log);

      try {
        await client.views.update({
          view_id: body.view.id,
          hash: body.view.hash,
          view: startModalView(kibanaUsername, { method, canAutoProvision: true }),
        });
      } catch (err) {
        log.warn('failed to switch start modal view', { err });
      }
    },
    { requireUser: false }
  );

  reg.view(VIEWS.START_SUBMIT, async ({ ack, view, client, ctx, slackUserId, log }) => {
    // Slack omits state.values entries for blocks it considers empty
    const values = view?.state?.values || {};
    const method = values.method_block?.method_select?.selected_option?.value === 'auto'
      ? 'auto'
      : 'manual';
    const kibanaUsername = parseKibanaUsername(view.private_metadata, log);

    if (method === 'auto') {
      const adminApiKey = String(values.admin_key_block?.admin_key_input?.value ?? '').trim();

      if (!adminApiKey) {
        await ack({
          response_action: 'errors',
          errors: { admin_key_block: 'Paste an admin API key with permission to create API keys.' },
        });
        log.debug('empty admin key submitted');
        return;
      }

      // Ack the modal closed right away - provisioning is a network round trip
      // to Elastic and view submissions get only a few seconds before Slack
      // times the ack out. Success/failure is reported by DM instead
      await ack();

      const previous = ctx.users.get(slackUserId);
      const keyName = `elastibot-${kibanaUsername || slackUserId}`;

      let provisioned;
      try {
        provisioned = await provisionAnalystApiKey(adminApiKey, keyName);
      } catch (err) {
        // Deliberately does NOT log adminApiKey or any part of it
        log.warn('automatic API key provisioning failed', { kibanaUsername, err });
        await safeDm(
          client,
          slackUserId,
          `:x: Couldn't create your Elastic API key automatically — ${provisioningErrorMessage(err)}\n` +
            'Run `/start` again and either try a different admin credential, or choose ' +
            '"I\'ll paste my own key" to register one yourself.',
          log
        );
        return;
      }

      ctx.users.set(slackUserId, { kibanaUsername, apiKey: provisioned.apiKey });

      // Drop the Elastic client built from the key being replaced, same as the
      // manual path
      if (previous?.apiKey && previous.apiKey !== provisioned.apiKey) {
        invalidateClient(previous.apiKey);
      }

      // Deliberately does NOT log the created key or any part of it
      log.info('analyst registered via automatic API key provisioning', {
        kibanaUsername,
        reregistered: Boolean(previous),
        encryptedAtRest: Boolean(config.security.encryptionKey),
        keyId: provisioned.id,
        keyName: provisioned.name,
      });

      await safeDm(
        client,
        slackUserId,
        `:white_check_mark: You're connected as *${kibanaUsername || 'your Elastic user'}*. ` +
          `Elastibot created a new API key for you (\`${provisioned.name}\`), scoped to just ` +
          'reading alerts and managing cases. The admin credential you pasted was used once ' +
          'and was not stored. Cases you create with `/case` will be attributed to you.' +
          (config.security.encryptionKey
            ? ''
            : '\n:warning: Note: `ELASTIBOT_SECRET_KEY` is not set, so your key is stored ' +
              'unencrypted. Ask your admin to enable at-rest encryption.'),
        log
      );
      return;
    }

    // method === 'manual' - unchanged behaviour: store whatever was pasted in,
    // no verification call against Elastic
    const apiKey = String(values.apikey_block?.apikey_input?.value ?? '').trim();

    if (!apiKey) {
      await ack({
        response_action: 'errors',
        errors: { apikey_block: 'Please paste your encoded API key.' },
      });
      log.debug('empty key submitted');
      return;
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

    await safeDm(
      client,
      slackUserId,
      `:white_check_mark: You're connected as *${kibanaUsername || 'your Elastic user'}*. ` +
        'Cases you create with `/case` will be attributed to you.' +
        (config.security.encryptionKey
          ? ''
          : '\n:warning: Note: `ELASTIBOT_SECRET_KEY` is not set, so your key is stored ' +
            'unencrypted. Ask your admin to enable at-rest encryption.'),
      log
    );
  });
};

module.exports.startModalView = startModalView;