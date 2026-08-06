'use strict';

const config = require('../../config');
const { CURSOR_FIELD } = require('../elastic');
const { incidentMessage } = require('../services/incidentBlocks');
const { renderIncident } = require('../services/incidentRender');
const { groupAlerts } = require('../grouping');
const { STATE_KEYS } = require('../constants');
const { logger } = require('../util/logger');

/*
 * The alert watcher.
 *
 * Asks Elastic for alerts newer than the saved cursor, collapses related ones
 * into incidents, and either posts a new message or updates the message an
 * earlier tick already posted for that incident
 *
 *
 * On first run (no saved cursor) we start watching from "now" instead of
 * backfilling history, so a fresh deploy doesn't flood the channel and trip
 * Slack rate limits
 *
 * The cursor is read from alert.cursorTimestamp, which is the field
 * getAlertsSince filters and sorts on. alert.timestamp is a different field
 */

const log = logger.child({ scope: 'watcher:alerts' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Rule breakdown for a subset of a group's alerts, for the pending section */
function ruleCountsFor(alerts, ids) {
  const want = new Set(ids);
  const counts = {};
  for (const a of alerts) {
    if (!want.has(a.id)) continue;
    const rn = a.ruleName || 'Unknown Rule';
    counts[rn] = (counts[rn] || 0) + 1;
  }
  return counts;
}

/**
 * @param {object} deps
 * @param {object} deps.slack      Bolt web client
 * @param {object} deps.state      StateStore
 * @param {object} deps.incidents  IncidentStore
 * @param {object} deps.elastic    Elastic service client
 * @param {object} deps.spaces     space service (getName)
 * @param {function} deps.channelFor  spaceId > channel id
 * @returns {Promise<{posted:number,updated:number,skipped:number,failed:number,reaped:number}>}
 */
async function pollAlerts({ slack, state, incidents, elastic, spaces, channelFor }) {
  const result = { posted: 0, updated: 0, skipped: 0, failed: 0, reaped: 0 };

  // Reap first. An incident that went quiet overnight must not absorb this
  // morning's alerts into a message nobody is reading any more
  result.reaped = incidents.sweep();

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

  // A full page means there are probably more waiting. The cursor still
  // advances to the newest one we saw, so nothing is lost
  if (alerts.length >= config.watchers.fetchSize) {
    log.warn('poll hit the fetch ceiling - alerts may be arriving faster than we post them', {
      fetchSize: config.watchers.fetchSize,
      remedy: 'raise WATCH_FETCH_SIZE or lower WATCH_POLL_MS',
    });
  }

  // Collapse related alerts into incidents. See grouping.js for the machine
  // identity merge that stops SYSTEM splitting a host off from its user
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

    // Does this burst belong to something already on the wall?
    const existing = incidents.findMatch(group);

    try {
      if (existing) {
        await updateIncident({ slack, incidents, existing, group, result });
      } else {
        await postIncident({ slack, incidents, group, channel, spaceName, result });
      }
      await sleep(config.watchers.postDelayMs);
    } catch (err) {
      result.failed += 1;
      log.warn('incident post/update failed', {
        err,
        channel,
        spaceId: group.spaceId,
        host: group.hostName,
        count: group.count,
      });
    }
  }

  // The cursor advances past failed posts too, so those incidents are dropped
  // rather than retried
  if (result.failed > 0) {
    log.error('some incidents were not posted and will not be retried', {
      failed: result.failed,
      posted: result.posted,
      updated: result.updated,
    });
  }

  // Advance on the max cursor timestamp in the batch, not on array position
  let newest = null;
  for (const a of alerts) {
    const t = a.cursorTimestamp;
    if (!t) continue;
    if (newest === null || Date.parse(t) > Date.parse(newest)) newest = t;
  }

  if (!newest) {
    // Nothing usable to advance to. Holding replays the batch next tick
    log.error('no usable cursor timestamp in the batch - cursor held, alerts WILL repeat', {
      field: CURSOR_FIELD,
      count: alerts.length,
      remedy: `check that ${CURSOR_FIELD} is mapped in ALERTS_INDEX`,
    });
  } else if (newest === since && alerts.length >= config.watchers.fetchSize) {
    // More than fetchSize alerts share one millisecond, so `gt` can never step
    // past them. Move 1ms and drop the remaining ties
    const bumped = new Date(Date.parse(newest) + 1).toISOString();
    log.error('cursor stalled on a full page of identical timestamps - forcing it forward', {
      since,
      bumped,
      fetchSize: config.watchers.fetchSize,
      remedy: 'raise WATCH_FETCH_SIZE',
    });
    state.set(STATE_KEYS.ALERTS_LAST_TS, bumped);
  } else {
    state.set(STATE_KEYS.ALERTS_LAST_TS, newest);
  }

  log.debug('alert poll complete', { ...result, cursor: newest });
  return result;
}

/**
 * First sighting of this incident.
 *
 * Posted in two steps on purpose. The incident key is derived from the Slack
 * message ts, and the buttons carry that key - so there is no key to put on a
 * button until Slack has told us where the message landed. Post a plain-text
 * skeleton, open the record, then fill in the blocks
 */
async function postIncident({ slack, incidents, group, channel, spaceName, result }) {
  const fallback =
    group.count > 1
      ? `${group.count} related alerts: ${group.representativeRule}`
      : `New alert: ${group.representativeRule}`;

  const posted = await slack.chat.postMessage({ channel, text: fallback });

  const rec = incidents.open({ group, channel, messageTs: posted.ts, spaceName });
  const msg = incidentMessage(rec, incidents.pending(rec));

  await slack.chat.update({ channel, ts: posted.ts, ...msg });

  result.posted += 1;
  log.info('incident posted', {
    key: rec.key,
    host: rec.hostName,
    user: rec.primaryUser,
    users: rec.userNames,
    count: rec.alertIds.length,
  });
}

/** Fold into an existing incident and re-render its message in place */
async function updateIncident({ slack, incidents, existing, group, result }) {
  const { rec, addedIds } = incidents.merge(existing.key, group);

  if (!addedIds.length) {
    // Every alert in this burst is already on the message. Happens when a poll
    // overlaps its predecessor; nothing to say
    result.skipped += 1;
    log.debug('incident merge added nothing new', { key: rec.key });
    return;
  }

  const pending = incidents.pending(rec);

  await renderIncident(slack, incidents, rec.key, {
    pendingRuleCounts: ruleCountsFor(group.alerts, pending),
    repostIfGone: true,
  });

  result.updated += 1;
  log.info('incident updated', {
    key: rec.key,
    added: addedIds.length,
    total: rec.alertIds.length,
    pending: pending.length,
    caseId: rec.caseId,
  });
}

module.exports = { pollAlerts };