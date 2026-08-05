'use strict';

const { addAlertToCase } = require('../services/caseService');
const { alertAddedBlocks } = require('../services/format');
const { COMMANDS } = require('../constants');

/*
 * /add_alert (caseID) (alertID)
 *   Attaches an alert to an existing case
 */

module.exports = function registerAddAlert(reg) {
  reg.command(
    COMMANDS.ADD_ALERT,
    async ({ argv, user, reply, slackUserId, log }) => {
      const [caseId, alertId] = argv;
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