'use strict';

const { createCaseForAlert, createCaseForGroup } = require('../services/caseService');
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

module.exports = function registerCase(reg) {
  reg.command(
    '/case',
    async ({ args, user, reply, slackUserId, log }) => {
      const alertId = args[0];
      const result = await createCaseForAlert(user.apiKey, alertId);

      log.info('case created', {
        caseId: result.caseId,
        alertCount: result.alertCount ?? 1,
        spaceName: result.spaceName,
      });

      await reply.inChannel({
        blocks: caseCreatedBlocks({ ...result, slackUserId }),
        text: `Case created: ${result.title} (${result.caseId})`,
      });
    },
    {
      requireUser: true,
      usage: 'Usage: `/case <alertID>`',
      minArgs: 1,
    }
  );

  // Button on watcher alert notifications - creates ONE case for the whole
  // incident (all correlated alerts), not just the alert that was clicked
  reg.action(
    'create_case_from_alert',
    async ({ action, user, reply, slackUserId, log }) => {
      const desc = decodeGroupValue(action.value);
      log.debug('create-case button', { kind: desc.k, space: desc.s });

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

      log.info('case created from button', {
        caseId: result.caseId,
        alertCount: result.alertCount ?? 1,
      });

      await reply.inChannel({
        blocks: caseCreatedBlocks({ ...result, slackUserId }),
        text: `Case created: ${result.title} (${result.caseId})`,
      });
    },
    { requireUser: true }
  );
};