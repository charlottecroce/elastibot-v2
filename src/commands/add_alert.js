'use strict';

const { addAlertToCase } = require('../services/caseService');
const { alertAddedBlocks } = require('../services/format');
const { renderIncident } = require('../services/incidentRender');
const { COMMANDS } = require('../constants');

/*
 * /add_alert (caseID) (alertID)
 *   Attaches an alert to an existing case
 *
 * This is also the manual fallback for the "Add N new alerts to case" button:
 * incidentBlocks.js#pendingBlocks renders one of these commands per pending
 * alert, inside a fence, precisely so an analyst can copy them out when the
 * button fails. Without it the message goes on listing an alert as pending
 * forever, and the button goes on offering to attach something Kibana already
 * has.
 */

module.exports = function registerAddAlert(reg) {
  reg.command(
    COMMANDS.ADD_ALERT,
    async ({ argv, user, reply, slackUserId, client, ctx, log }) => {
      const [caseId, alertId] = argv;
      const result = await addAlertToCase(user.apiKey, caseId, alertId);

      log.info('alert attached', { caseId: result.caseId, alertId: result.alertId });

      /*
       * Only when the alert landed on the incident's OWN case. `/add_alert` is
       * equally a way to file an alert onto some unrelated case - a different
       * investigation, a case from last week - and marking it attached here
       * would tell the incident message a lie: the alert would stop appearing
       * as pending while still not being on the case the message links to.
       */
      const incident = ctx.incidents.findByAlertId(result.alertId);
      if (incident && incident.caseId === result.caseId) {
        ctx.incidents.recordAttached(incident.key, [result.alertId]);
        // renderIncident swallows Slack failures and returns null, so a stale
        // message never fails the attach the analyst actually asked for
        await renderIncident(client, ctx.incidents, incident.key);
        log.debug('incident message refreshed after manual attach', { key: incident.key });
      }

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