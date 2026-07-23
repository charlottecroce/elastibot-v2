'use strict';

const { createCaseForAlert, UserFacingError } = require('../services/caseService');
const { caseCreatedBlocks } = require('../services/format');

/*
 * /case (alertID)
 *   Creates a case for the alert in the alert's space, titled per the naming
 *   scheme, and attaches the alert. Reply is posted in-channel so the team sees
 *   the new case ID (needed for /add_alert).
 *
 * Also registers the "Create case" button that the alert watcher attaches to new-alert notifications
 */

const NEED_START =
  'You need to connect first. Run `/start <kibana_username>` to register your Elastic API key.';

module.exports = function registerCase(app, ctx) {
  app.command('/case', async ({ command, ack, respond }) => {
    await ack();
    const alertId = (command.text || '').trim().split(/\s+/)[0];

    if (!alertId) {
      await respond({
        response_type: 'ephemeral',
        text: 'Usage: `/case <alertID>`',
      });
      return;
    }

    const user = ctx.users.get(command.user_id);
    if (!user) {
      await respond({ response_type: 'ephemeral', text: NEED_START });
      return;
    }

    try {
      const result = await createCaseForAlert(user.apiKey, alertId);
      await respond({
        response_type: 'in_channel',
        blocks: caseCreatedBlocks({ ...result, slackUserId: command.user_id }),
        text: `Case created: ${result.title} (${result.caseId})`,
      });
    } catch (err) {
      const msg = err instanceof UserFacingError ? err.message : `Unexpected error: ${err.message}`;
      await respond({ response_type: 'ephemeral', text: `:x: ${msg}` });
    }
  });

  // Button on watcher alert notifications
  app.action('create_case_from_alert', async ({ ack, body, action, client, respond }) => {
    await ack();
    const alertId = action.value;
    const slackUserId = body.user.id;

    const user = ctx.users.get(slackUserId);
    if (!user) {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: slackUserId,
        text: NEED_START,
      });
      return;
    }

    try {
      const result = await createCaseForAlert(user.apiKey, alertId);
      await client.chat.postMessage({
        channel: body.channel.id,
        blocks: caseCreatedBlocks({ ...result, slackUserId }),
        text: `Case created: ${result.title} (${result.caseId})`,
      });
    } catch (err) {
      const msg = err instanceof UserFacingError ? err.message : `Unexpected error: ${err.message}`;
      await client.chat.postEphemeral({ channel: body.channel.id, user: slackUserId, text: `:x: ${msg}` });
    }
  });
};