'use strict';

const { getAlertStatistics } = require('../statsService');
const { statsBlocks, STATS_USAGE } = require('../statsBlocks');
const { COMMANDS } = require('../constants');

/*
 * /stats [window] [filters] [share]
 *   Aggregate view of the alerts index: top/noisiest rules, severity + risk
 *   spread, top hosts/users/processes.
 *
 *   Runs under the analyst's own API key, replies ephemerally by default unless
 *   the analyst adds `share`.
 *
 * Three imports changed here and all three were broken:
 *   ../services/statsService  ->  ../statsService   (no services/ dir any more)
 *   core/services/format      ->  ../statsBlocks    (format.js was split up)
 *   ../../cases/constants     ->  ../constants      (a CROSS-FEATURE import for
 *                                                    the string '/stats', which
 *                                                    eslint now refuses)
 */

module.exports = function registerStats(reg) {
  reg.command(
    COMMANDS.STATS,
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