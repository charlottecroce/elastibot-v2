'use strict';

const {
  createCaseForAlert,
  createCaseForIds,
  attachAlertsToCase,
} = require('../services/caseService');
const { caseCreatedBlocks, alertAddedBlocks } = require('../services/format');
const { renderIncident } = require('../services/incidentRender');
const { withClaim, claimRefusal } = require('../services/incidentClaim');
const { mrkdwnLink } = require('../util/mrkdwn');
const { ACTIONS, COMMANDS } = require('../constants');

/*
 * /case (alertID)
 *   Creates a case for THAT ONE ALERT in the alert's own space, titled per the
 *   naming scheme, and attaches it.
 *
 * Plus the two buttons the alert watcher puts on incident messages:
 *   Create case          takes the incident claim, files every alert on the
 *                        message into one case, re-renders the message
 *   Add N alerts to case attaches the pending alerts to the case that already
 *                        exists, re-renders the message
 *
 * Swapping the green button for a grey one does NOT by itself make a duplicate
 * case impossible, which is the stated goal. Between the click and the message
 * update there are two or three Elastic round trips - comfortably a second or
 * more - and for that whole window the button is still green on every other
 * analyst's screen. Two people looking at the same alert at 3am click within
 * that window and you get two cases, exactly as before.
 *
 * So the button swap is the UI half and incidents.tryClaim is the enforcement
 * half. The claim is taken synchronously before any network call, so the second
 * click loses instantly and gets told who is already on it. The button swap
 * then stops anyone reaching the click at all a second later
 *
 * Every case link below goes through mrkdwnLink. rec.caseLink is nullable -
 * caseLinkForIncident returns null when no public base URL resolves - and
 * Slack does not validate the url half of a mrkdwn link, so interpolating it
 * directly renders the literal word "undefined" into the channel.
 */

module.exports = function registerCase(reg) {
  reg.command(
    COMMANDS.CASE,
    async ({ argv, user, reply, slackUserId, client, ctx, log }) => {
      const alertId = argv[0];

      /*
       * If this alert is already on a posted incident, route through the same
       * claim as the button. Otherwise `/case <id>` is a back door straight past
       * every duplicate check we just built
       */
      const existing = ctx.incidents.findByAlertId(alertId);
      if (existing?.caseId) {
        await reply.ephemeral(
          `Alert \`${alertId}\` is already part of an incident with case ` +
            `${mrkdwnLink(existing.caseLink, existing.caseId)}. ` +
            'Use the *Add new alerts to case* button on that message, or `/add_alert` ' +
            'if you want it somewhere else.'
        );
        return;
      }

      const result = await createCaseForAlert(user.apiKey, alertId);

      log.info('case created', {
        caseId: result.caseId,
        alertCount: result.alertCount ?? 1,
        spaceName: result.spaceName,
      });

      // Keep the block kit honest even though the case came from a command
      if (existing) {
        ctx.incidents.recordCase(existing.key, result, [alertId]);
        await renderIncident(client, ctx.incidents, existing.key);
      }

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

  /*
   * Green "Create case" - one case for the whole incident
   */
  reg.action(
    ACTIONS.CREATE_CASE_FROM_ALERT,
    async ({ action, user, reply, slackUserId, client, ctx, log }) => {
      const key = action.value;
      const claim = await withClaim(ctx.incidents, key, slackUserId, async (rec) => {
        /*
         * Swap the green button for a "creating…" note on everyone else's
         * screen. Deliberately not awaited: the claim is already held, so the
         * duplicate is already impossible, and blocking on a Slack round trip
         * here would only delay the case the analyst is waiting on. Purely
         * cosmetic work does not belong on the critical path
         */
        renderIncident(client, ctx.incidents, key).catch(() => {});

        const result = await createCaseForIds(user.apiKey, rec.alertIds, {
          spaceId: rec.spaceId,
        });

        ctx.incidents.recordCase(key, result, result.attachedIds);
        await renderIncident(client, ctx.incidents, key);
        return result;
      });

      if (!claim.ok) {
        await reply.ephemeral(claimRefusal(claim));
        // The refuser's view is stale by definition - push them the truth
        await renderIncident(client, ctx.incidents, key);
        return;
      }

      const result = claim.value;
      log.info('case created from incident', {
        key,
        caseId: result.caseId,
        alertCount: result.alertCount,
        attached: result.attachedCount,
      });

      await reply.inChannel({
        blocks: caseCreatedBlocks({ ...result, slackUserId }),
        text: `Case created: ${result.title} (${result.caseId})`,
      });
    },
    { requireUser: true }
  );

  /*
   * Green "Add N new alerts to case" - attaches everything on the message that
   * isn't on the case yet
   */
  reg.action(
    ACTIONS.ADD_ALERTS_TO_CASE,
    async ({ action, user, reply, slackUserId, client, ctx, log }) => {
      const key = action.value;
      const rec = ctx.incidents.get(key);

      if (!rec) {
        await reply.ephemeral(
          'That incident has closed out (no new alerts for ' +
            `${Math.round(ctx.incidents.idleMs / 3600000)}h) and is no longer tracked. ` +
            'Use `/add_alert <caseID> <alertID>` for the alert IDs on the message.'
        );
        return;
      }
      if (!rec.caseId) {
        await reply.ephemeral('No case on this incident yet — use *Create case* first.');
        await renderIncident(client, ctx.incidents, key);
        return;
      }

      const pending = ctx.incidents.pending(rec);
      if (!pending.length) {
        // Two people clicked; the first one already attached them
        await reply.ephemeral(
          `Everything on this incident is already on ${mrkdwnLink(rec.caseLink, rec.caseId)}.`
        );
        await renderIncident(client, ctx.incidents, key);
        return;
      }

      // Same claim, different reason: two clicks would double-attach, and
      // Kibana's attach is not idempotent
      const claim = await withClaim(
        ctx.incidents,
        key,
        slackUserId,
        async () => {
          const res = await attachAlertsToCase(user.apiKey, {
            spaceId: rec.spaceId,
            caseId: rec.caseId,
            alertIds: pending,
          });
          ctx.incidents.recordAttached(key, res.attachedIds);
          await renderIncident(client, ctx.incidents, key);
          return res;
        },
        { allowExistingCase: true }
      );

      if (!claim.ok) {
        await reply.ephemeral(claimRefusal(claim));
        return;
      }

      const res = claim.value;
      log.info('alerts added to case from incident', {
        key,
        caseId: rec.caseId,
        added: res.attachedIds.length,
        failed: pending.length - res.attachedIds.length,
      });

      await reply.inChannel({
        blocks: alertAddedBlocks({
          caseId: rec.caseId,
          alertId: `${res.attachedIds.length} alert${res.attachedIds.length === 1 ? '' : 's'}`,
          ruleName: rec.representativeRule,
          link: rec.caseLink,
          slackUserId,
        }),
        text: `${res.attachedIds.length} alerts added to case ${rec.caseId}`,
      });
    },
    { requireUser: true }
  );
};