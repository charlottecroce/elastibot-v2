'use strict';

const { createCaseForAlert, createCaseForGroup } = require('../services/caseService');
const { caseCreatedBlocks } = require('../services/format');
const { decodeGroupValue } = require('../grouping');
const { ACTIONS, COMMANDS } = require('../constants');

/*
 * /case (alertID)
 *   Creates a case for THAT ONE ALERT in the alert's own space, titled per the
 *   naming scheme, and attaches it.
 *
 * Also registers the "Create case" button the alert watcher attaches to its
 * notifications. That path is the one that groups: for a correlated incident it
 * re-runs the user+host+time-range query and files the whole burst into a single
 * case
 */

module.exports = function registerCase(reg) {
  reg.command(
    COMMANDS.CASE,
    async ({ argv, user, reply, slackUserId, log }) => {
      const alertId = argv[0];
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
  // incident (all correlated alerts), not just the alert that was clicked.
  // action_id is the same constant services/format.js stamps on the button
  reg.action(
    ACTIONS.CREATE_CASE_FROM_ALERT,
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