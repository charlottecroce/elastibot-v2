'use strict';

const { addAlertToCase, UserFacingError } = require('../services/caseService');
const { alertAddedBlocks } = require('../services/format');

/*
 * /add_alert (caseID) (alertID)
 *   Attaches an alert to an existing case
 */

module.exports = function registerAddAlert(app, ctx) {
  app.command('/add_alert', async ({ command, ack, respond }) => {
    await ack();
    const [caseId, alertId] = (command.text || '').trim().split(/\s+/);

    if (!caseId || !alertId) {
      await respond({
        response_type: 'ephemeral',
        text: 'Usage: `/add_alert <caseID> <alertID>`',
      });
      return;
    }

    const user = ctx.users.get(command.user_id);
    if (!user) {
      await respond({
        response_type: 'ephemeral',
        text: 'Run `/start <kibana_username>` first to register your Elastic API key.',
      });
      return;
    }

    try {
      const result = await addAlertToCase(user.apiKey, caseId, alertId);
      await respond({
        response_type: 'in_channel',
        blocks: alertAddedBlocks({ ...result, slackUserId: command.user_id }),
        text: `Alert ${result.alertId} added to case ${result.caseId}`,
      });
    } catch (err) {
      const msg = err instanceof UserFacingError ? err.message : `Unexpected error: ${err.message}`;
      await respond({ response_type: 'ephemeral', text: `:x: ${msg}` });
    }
  });
};