'use strict';

const { addAlertToCase } = require('../services/caseService');
const { alertAddedBlocks } = require('../services/format');

/*
 * /add_alert (caseID) (alertID)
 *   Attaches an alert to an existing case
 */

module.exports = function registerAddAlert(reg) {
  reg.command(
    '/add_alert',
    async ({ args, user, reply, slackUserId, log }) => {
      const [caseId, alertId] = args;
      const result = await addAlertToCase(user.apiKey, caseId, alertId);

      log.info('alert attached', { caseId: result.caseId, alertId: result.alertId });

      await reply.inChannel({
        blocks: alertAddedBlocks({ ...result, slackUserId }),
        text: `Alert ${result.alertId} added to case ${result.caseId}`,
      });
    },
    {
      requireUser: true,
      usage: 'Usage: `/add_alert <caseID> <alertID>`',
      minArgs: 2,
    }
  );
};