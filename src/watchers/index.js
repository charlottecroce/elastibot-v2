'use strict';

const config = require('../../config');
const { serviceClient } = require('../elastic');
const { caseUrl, alertGroupBlocks, newCaseBlocks } = require('../services/format');
const { groupAlerts, encodeGroupValue } = require('../grouping');

/*
 * Polling watchers. Every pollIntervalMs we ask Elastic for anything new since
 * the last run and post it to the routed Slack channel. Last-seen timestamps
 * are persisted so restarts don't replay or miss items.
 *
 * Alerts are grouped by user + host (within the grouping window) before posting,
 * so a burst of related alerts becomes ONE channel message with a single
 * "Create case" button rather than one message per alert.
 *
 * Routing: config.watchers.channelRouting[spaceId] || config.watchers.defaultChannel
 */

const STATE_ALERTS = 'alertsLastTs';
const STATE_CASES = 'casesLastTs'; // { [spaceId]: iso }

function channelFor(spaceId) {
  return config.watchers.channelRouting[spaceId] || config.watchers.defaultChannel || '';
}

async function pollAlerts(client, state, spaceNameCache) {
  const since = state.get(STATE_ALERTS, null);
  let alerts;
  try {
    alerts = await serviceClient.getAlertsSince(since, config.watchers.fetchSize);
  } catch (err) {
    console.error('[watcher:alerts] query failed:', err.response?.status || err.message);
    return;
  }
  if (!alerts.length) return;

  // Collapse related alerts (same user + host, within the window) into incidents
  const groups = groupAlerts(alerts, config.grouping.windowMs);

  for (const group of groups) {
    const channel = channelFor(group.spaceId);
    if (!channel) continue; // no route configured > skip quietly

    let spaceName = spaceNameCache.get(group.spaceId);
    if (!spaceName) {
      spaceName = await serviceClient.getSpaceName(group.spaceId);
      spaceNameCache.set(group.spaceId, spaceName);
    }

    try {
      await client.chat.postMessage({
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
    } catch (err) {
      console.error('[watcher:alerts] post failed:', err.data?.error || err.message);
    }
  }

  // Advance the cursor to the newest alert we just processed
  const newest = alerts[alerts.length - 1].timestamp;
  if (newest) state.set(STATE_ALERTS, newest);
}

async function pollCases(client, state, spaceNameCache) {
  const cursors = state.get(STATE_CASES, {});

  for (const spaceId of config.watchers.cases.spaces) {
    const channel = channelFor(spaceId);
    if (!channel) continue;

    let cases;
    try {
      cases = await serviceClient.findRecentCases(spaceId, 25);
    } catch (err) {
      console.error(`[watcher:cases:${spaceId}] query failed:`, err.response?.status || err.message);
      continue;
    }

    const since = cursors[spaceId] || null;
    // Cases come newest-first; keep only ones newer than our cursor, then post oldest-first
    const fresh = cases
      .filter((c) => !since || new Date(c.created_at) > new Date(since))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    if (!fresh.length) {
      // Initialise cursor on first run so we don't backfill the whole history
      if (!since && cases.length) cursors[spaceId] = cases[0].created_at;
      continue;
    }

    let spaceName = spaceNameCache.get(spaceId);
    if (!spaceName) {
      spaceName = await serviceClient.getSpaceName(spaceId);
      spaceNameCache.set(spaceId, spaceName);
    }

    for (const c of fresh) {
      try {
        await client.chat.postMessage({
          channel,
          text: `New case: ${c.title}`,
          blocks: newCaseBlocks({
            title: c.title,
            caseId: c.id,
            spaceName,
            link: caseUrl(spaceId, c.id, c.owner),
            createdBy: c.created_by?.username || c.created_by?.full_name,
          }),
        });
      } catch (err) {
        console.error(`[watcher:cases:${spaceId}] post failed:`, err.data?.error || err.message);
      }
    }

    cursors[spaceId] = fresh[fresh.length - 1].created_at;
  }

  state.set(STATE_CASES, cursors);
}

/**
 * Start the polling loop. Returns a stop() function
 */
function startWatchers(app, state) {
  if (!config.watchers.enabled) {
    console.log('[watchers] disabled via config.');
    return () => {};
  }
  if (!serviceClient) {
    console.warn('[watchers] ELASTIC_SERVICE_API_KEY not set — watchers cannot run.');
    return () => {};
  }
  if (!config.watchers.defaultChannel && Object.keys(config.watchers.channelRouting).length === 0) {
    console.warn('[watchers] no channel routing configured — nothing will be posted.');
  }

  const client = app.client;
  const spaceNameCache = new Map();
  let running = false;

  const tick = async () => {
    if (running) return; // avoid overlap on slow clusters
    running = true;
    try {
      if (config.watchers.alerts.enabled) await pollAlerts(client, state, spaceNameCache);
      if (config.watchers.cases.enabled) await pollCases(client, state, spaceNameCache);
    } catch (err) {
      console.error('[watchers] tick error:', err.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, config.watchers.pollIntervalMs);
  tick(); // run once immediately
  console.log(`[watchers] polling every ${config.watchers.pollIntervalMs}ms.`);
  return () => clearInterval(timer);
}

module.exports = { startWatchers };