'use strict';

const config = require('../../config');
const { alertGroupBlocks } = require('../services/format');
const { groupAlerts, encodeGroupValue } = require('../grouping');
const { STATE_KEYS } = require('../constants');
const { logger } = require('../util/logger');

/*
 * The alert watcher.
 *
 * Asks Elastic for alerts newer than the saved cursor, collapses related ones
 * into incidents, and posts one message per incident to the routed channel.
 *
 * On first run (no saved cursor) we start watching from "now" instead of
 * backfilling history, so a fresh deploy doesn't flood the channel and trip
 * Slack rate limits
 *
 */

const log = logger.child({ scope: 'watcher:alerts' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} deps
 * @param {object} deps.slack    Bolt web client
 * @param {object} deps.state    StateStore
 * @param {object} deps.elastic  Elastic service client
 * @param {object} deps.spaces   space service (getName)
 * @param {function} deps.channelFor  spaceId > channel id
 * @returns {Promise<{posted:number,skipped:number,failed:number}>}
 */
async function pollAlerts({ slack, state, elastic, spaces, channelFor }) {
  const result = { posted: 0, skipped: 0, failed: 0 };
  const since = state.get(STATE_KEYS.ALERTS_LAST_TS, null);

  // First run: start from now, don't replay history
  if (!since) {
    const from = new Date().toISOString();
    state.set(STATE_KEYS.ALERTS_LAST_TS, from);
    log.info('no cursor found - watching from now, not backfilling', { from });
    return result;
  }

  let alerts;
  try {
    alerts = await elastic.getAlertsSince(since, config.watchers.fetchSize);
  } catch (err) {
    log.error('alert query failed - cursor not advanced', { err, since });
    return result;
  }

  if (!alerts.length) {
    log.debug('no new alerts', { since });
    return result;
  }

  /*
   * If we got exactly fetchSize back, there are probably more waiting. The
   * cursor still advances to the newest one we saw, so nothing is lost - but a
   * sustained burst means we're a poll behind, which is worth knowing before
   * someone notices alerts arriving late
   */
  if (alerts.length >= config.watchers.fetchSize) {
    log.warn('poll hit the fetch ceiling - alerts may be arriving faster than we post them', {
      fetchSize: config.watchers.fetchSize,
      remedy: 'raise WATCH_FETCH_SIZE or lower WATCH_POLL_MS',
    });
  }

  // Collapse related alerts (same user + host, within the window) into incidents
  const groups = groupAlerts(alerts, config.grouping.windowMs);
  log.info('new alerts', { alerts: alerts.length, incidents: groups.length, since });

  for (const group of groups) {
    const channel = channelFor(group.spaceId);
    if (!channel) {
      // no route configured > skip, but count it: a permanently unrouted space
      // is a config mistake worth seeing in the tick summary
      result.skipped += 1;
      log.debug('no channel routed for space - skipping incident', {
        spaceId: group.spaceId,
        count: group.count,
      });
      continue;
    }

    const spaceName = await spaces.getName(group.spaceId, elastic);

    try {
      await slack.chat.postMessage({
        channel,
        text:
          group.count > 1
            ? `${group.count} related alerts: ${group.representativeRule}`
            : `New alert: ${group.representativeRule}`,
        blocks: alertGroupBlocks({
          count: group.count,
          representativeRule: group.representativeRule,
          ruleCounts: group.ruleCounts,
          topSeverity: group.topSeverity,
          userName: group.userName,
          hostName: group.hostName,
          spaceName,
          from: group.from,
          to: group.to,
          alertId: group.alerts[0].id,
          buttonValue: encodeGroupValue(group),
        }),
      });
      result.posted += 1;
      await sleep(config.watchers.postDelayMs);
    } catch (err) {
      result.failed += 1;
      log.warn('post failed', { err, channel, spaceId: group.spaceId, count: group.count });
    }
  }

  // Advance the cursor to the newest alert we just processed
  const newest = alerts[alerts.length - 1].timestamp;
  if (newest) state.set(STATE_KEYS.ALERTS_LAST_TS, newest);

  log.debug('alert poll complete', { ...result, cursor: newest });
  return result;
}

module.exports = { pollAlerts };