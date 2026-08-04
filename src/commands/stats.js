'use strict';

const { getAlertStatistics } = require('../services/statsService');
const { statsBlocks, STATS_USAGE } = require('../services/format');

/*
 * /stats [window] [filters] [share]
 *   Aggregate view of the alerts index: top/noisiest rules, severity + risk spread, top hosts/users/processes
 *
 *   Runs under the analyst's own API key, replies ephemerally by default unless the analyst adds `share`
 */

module.exports = function registerStats(reg) {
  reg.command(
    '/stats',
    async ({ text, user, reply, log }) => {
      if (/^(help|-h|--help|\?)$/i.test(text)) {
        await reply.ephemeral(STATS_USAGE);
        return;
      }

      const stats = await getAlertStatistics(user.apiKey, text);

      log.info('stats rendered', {
        window: stats.query.windowLabel,
        total: stats.total,
        shared: stats.query.share,
        filters: Object.keys(stats.query.filters || {}),
      });

      const payload = {
        blocks: statsBlocks(stats),
        text: `Alert statistics — last ${stats.query.windowLabel} (${stats.total} alerts)`,
      };

      if (stats.query.share) await reply.inChannel(payload);
      else await reply.ephemeral(payload);
    },
    {
      requireUser: true,
      userErrorSuffix: STATS_USAGE,
    }
  );
};