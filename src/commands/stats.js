'use strict';

const { getAlertStatistics } = require('../services/statsService');
const { UserFacingError } = require('../services/caseService');
const { statsBlocks, STATS_USAGE } = require('../services/format');

/*
 * /stats [window] [filters] [share]
 *   Aggregate view of the alerts index: top/noisiest rules, severity + risk spread, top hosts/users/processes
 *
 *   Runs under the analyst's own API key, replies ephemerally by default unless the analyst adds `share`
 */

const NEED_START =
  'You need to connect first. Run `/start <kibana_username>` to register your Elastic API key.';

module.exports = function registerStats(app, ctx) {
  app.command('/stats', async ({ command, ack, respond }) => {
    await ack();
    const text = (command.text || '').trim();

    if (/^(help|-h|--help|\?)$/i.test(text)) {
      await respond({ response_type: 'ephemeral', text: STATS_USAGE });
      return;
    }

    const user = ctx.users.get(command.user_id);
    if (!user) {
      await respond({ response_type: 'ephemeral', text: NEED_START });
      return;
    }

    try {
      const stats = await getAlertStatistics(user.apiKey, text);
      await respond({
        response_type: stats.query.share ? 'in_channel' : 'ephemeral',
        blocks: statsBlocks(stats),
        text: `Alert statistics — last ${stats.query.windowLabel} (${stats.total} alerts)`,
      });
    } catch (err) {
      const msg = err instanceof UserFacingError ? err.message : `Unexpected error: ${err.message}`;
      await respond({ response_type: 'ephemeral', text: `:x: ${msg}\n\n${STATS_USAGE}` });
    }
  });
};