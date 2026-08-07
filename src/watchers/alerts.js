'use strict';

const config = require('../../config');
const { CURSOR_FIELD } = require('../elastic');
const { incidentMessage } = require('../services/incidentBlocks');
const { renderIncident } = require('../services/incidentRender');
const { groupAlerts } = require('../grouping');
const { STATE_KEYS } = require('../constants');
const { sleep } = require('../util/sleep');
const { logger } = require('../util/logger');

/*
 * The alert watcher.
 *
 * Asks Elastic for alerts newer than the saved cursor, collapses related ones
 * into incidents, and either posts a new message or updates the message an
 * earlier tick posted for that incident.
 *
 * The cursor is alert.cursorTimestamp - the field getAlertsSince filters and
 * sorts on. alert.timestamp is a different field.
 */

const log = logger.child({ scope: 'watcher:alerts' });

/** Newest cursorTimestamp in a batch, or null when none are usable */
function newestCursor(alerts) {
  let newest = null;
  for (const a of alerts) {
    const t = a.cursorTimestamp;
    if (!t) continue;
    if (newest === null || Date.parse(t) > Date.parse(newest)) newest = t;
  }
  return newest;
}

/**
 * Move the cursor past the batch. Holding it replays the batch next tick.
 *
 * A full page sharing one millisecond can never be stepped past with `gt`, so
 * that case is forced forward 1ms and the remaining ties are dropped.
 *
 * @returns {string|null} the cursor now stored, or null if it was held
 */
function advanceCursor(state, alerts, since) {
  const newest = newestCursor(alerts);

  if (!newest) {
    log.error('no usable cursor timestamp in the batch - cursor held, alerts WILL repeat', {
      field: CURSOR_FIELD,
      count: alerts.length,
      remedy: `check that ${CURSOR_FIELD} is mapped in ALERTS_INDEX`,
    });
    return null;
  }

  if (newest === since && alerts.length >= config.watchers.fetchSize) {
    const bumped = new Date(Date.parse(newest) + 1).toISOString();
    log.error('cursor stalled on a full page of identical timestamps - forcing it forward', {
      since,
      bumped,
      fetchSize: config.watchers.fetchSize,
      remedy: 'raise WATCH_FETCH_SIZE',
    });
    state.set(STATE_KEYS.ALERTS_LAST_TS, bumped);
    return bumped;
  }

  state.set(STATE_KEYS.ALERTS_LAST_TS, newest);
  return newest;
}

/**
 * First sighting of this incident.
 *
 * The record is opened before the message is posted, because the buttons carry
 * the incident key and the key has to exist to render them.
 */
async function postIncident({ slack, incidents, group, channel, spaceName, result }) {
  const rec = incidents.open({ group, channel, spaceName });

  let posted;
  try {
    posted = await slack.chat.postMessage({
      channel,
      ...incidentMessage(rec, incidents.pending(rec)),
    });
  } catch (err) {
    // A record with no message would make findMatch fold the next tick's alerts
    // into a message that does not exist, and they would never be seen
    incidents.discard(rec.key);
    throw err;
  }

  incidents.setMessage(rec.key, { channel, messageTs: posted.ts });
  result.posted += 1;

  log.info('incident posted', {
    key: rec.key,
    host: rec.hostName,
    user: rec.primaryUser,
    count: rec.alertIds.length,
  });
}

/** Fold into an existing incident and re-render its message in place */
async function updateIncident({ slack, incidents, existing, group, result }) {
  const { rec, addedIds } = incidents.merge(existing.key, group);

  // Overlapping polls hit this constantly; a chat.update with no change is a
  // rate limit waiting to happen
  if (!addedIds.length) {
    result.skipped += 1;
    return;
  }

  await renderIncident(slack, incidents, rec.key, { repostIfGone: true });
  result.updated += 1;

  log.info('incident updated', {
    key: rec.key,
    added: addedIds.length,
    total: rec.alertIds.length,
    pending: incidents.pending(rec).length,
    caseId: rec.caseId,
  });
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

  // Reap first, so an incident that went quiet overnight can't absorb this
  // morning's alerts into a message nobody is reading
  result.reaped = incidents.sweep();

  const since = state.get(STATE_KEYS.ALERTS_LAST_TS, null);

  // First run: watch from now rather than replaying history into the channel
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
  if (!alerts.length) return result;

  if (alerts.length >= config.watchers.fetchSize) {
    log.warn('poll hit the fetch ceiling - alerts may arrive faster than they are posted', {
      fetchSize: config.watchers.fetchSize,
      remedy: 'raise WATCH_FETCH_SIZE or lower WATCH_POLL_MS',
    });
  }

  /*
   * Drop anything already shown on a live incident record.
   *
   * findMatch correlates by space + host + identity, so it cannot recognise a
   * hostless alert at all - without this filter a rewound cursor posts those a
   * second time. Cheap, and it makes replaying a batch idempotent.
   */
  const fresh = alerts.filter((a) => !incidents.findByAlertId(a.id));
  const alreadyPosted = alerts.length - fresh.length;
  if (alreadyPosted) {
    result.skipped += alreadyPosted;
    log.info('dropped alerts already on a posted message', { dropped: alreadyPosted, since });
  }

  // grouping.js folds machine identities in, so SYSTEM does not split a host
  // off from its user
  const groups = groupAlerts(fresh, config.grouping.windowMs);
  log.info('new alerts', { alerts: fresh.length, incidents: groups.length, since });

  for (const group of groups) {
    const channel = channelFor(group.spaceId);

    // A permanently unrouted space is a config mistake worth seeing in the
    // tick summary, so it is counted rather than silently ignored
    if (!channel) {
      result.skipped += 1;
      log.debug('no channel routed for space - skipping incident', {
        spaceId: group.spaceId,
        count: group.count,
      });
      continue;
    }

    const existing = incidents.findMatch(group);

    try {
      if (existing) {
        // No space lookup - the record carries its display name, and on a cold
        // cache getName is an HTTP round trip per group
        await updateIncident({ slack, incidents, existing, group, result });
      } else {
        const spaceName = await spaces.getName(group.spaceId, elastic);
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

  // The cursor advances past failures too, so those incidents are dropped
  // rather than retried
  if (result.failed > 0) {
    log.error('some incidents were not posted and will not be retried', {
      failed: result.failed,
      posted: result.posted,
      updated: result.updated,
    });
  }

  const cursor = advanceCursor(state, alerts, since);
  log.debug('alert poll complete', { ...result, cursor });
  return result;
}

module.exports = { pollAlerts };