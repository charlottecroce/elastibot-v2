'use strict';

const {
  createCaseForAlert,
  createCaseForGroup,
  UserFacingError,
} = require('../services/caseService');
const { caseCreatedBlocks } = require('../services/format');
const { decodeGroupValue } = require('../grouping');

/*
 * /case (alertID)
 *   Creates a case for the alert in the alert's space, titled per the naming
 *   scheme, and attaches the alert. If the alert has a user + host, sibling alerts
 *   within the grouping window are pulled in and filed into the same case.
 *   Reply is posted in-channel so the team sees the new case ID
 *
 * Also registers the "Create case" button the alert watcher attaches to its
 * notifications - it files the whole incident (all correlated alerts) into one case
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

  // Button on watcher alert notifications - creates ONE case for the whole
  // incident (all correlated alerts), not just the alert that was clicked
  app.action('create_case_from_alert', async ({ ack, body, action, client }) => {
    await ack();
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

    const desc = decodeGroupValue(action.value);

    try {
      const result =
        desc.k === 'g'
          ? await createCaseForGroup(user.apiKey, {
              spaceId: desc.s,
              userName: desc.u,
              hostName: desc.h,
              from: desc.f,
              to: desc.t,
            })
          : await createCaseForAlert(user.apiKey, desc.a);

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