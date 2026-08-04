'use strict';

const config = require('../../config');
const { serviceClient } = require('../elastic');
const { caseUrl, alertGroupBlocks, newCaseBlocks } = require('../services/format');
const { groupAlerts, encodeGroupValue } = require('../grouping');
const { logger } = require('../util/logger');

/*
 * Polling watchers. Every pollIntervalMs we ask Elastic for anything new since
 * the last run and post it to the routed Slack channel. Last-seen timestamps
 * are persisted so restarts don't replay or miss items.
 *
 * On first run (no saved cursor) we start watching from "now" instead of
 * backfilling history, so a fresh deploy doesn't flood the channel and trip
 * Slack rate limits.
 *
 * Alerts are grouped by user + host (within the grouping window) before posting,
 * so a burst of related alerts becomes ONE channel message with a single
 * "Create case" button rather than one message per alert.
 *
 * Routing: config.watchers.channelRouting[spaceId] || config.watchers.defaultChannel
 */

const STATE_ALERTS = 'alertsLastTs';
const STATE_CASES = 'casesLastTs'; // { [spaceId]: iso }

const log = logger.child({ scope: 'watchers' });
const alertLog = logger.child({ scope: 'watcher:alerts' });
const caseLog = logger.child({ scope: 'watcher:cases' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function channelFor(spaceId) {
  return config.watchers.channelRouting[spaceId] || config.watchers.defaultChannel || '';
}

async function pollAlerts(client, state, spaceNameCache) {
  const since = state.get(STATE_ALERTS, null);

  // First run: start from now, don't replay history
  if (!since) {
    const from = new Date().toISOString();
    state.set(STATE_ALERTS, from);
    alertLog.info('no cursor found - watching from now, not backfilling', { from });
    return;
  }

  let alerts;
  try {
    alerts = await serviceClient.getAlertsSince(since, config.watchers.fetchSize);
  } catch (err) {
    alertLog.error('alert query failed - cursor not advanced', { err, since });
    return;
  }
  if (!alerts.length) {
    alertLog.debug('no new alerts', { since });
    return;
  }

  // Collapse related alerts (same user + host, within the window) into incidents
  const groups = groupAlerts(alerts, config.grouping.windowMs);
  alertLog.info('new alerts', { alerts: alerts.length, incidents: groups.length, since });

  let posted = 0;
  let skipped = 0;

  for (const group of groups) {
    const channel = channelFor(group.spaceId);
    if (!channel) {
      // no route configured > skip quietly, but count it: a permanently
      // unrouted space is a config mistake worth seeing in the tick summary
      skipped += 1;
      alertLog.debug('no channel routed for space - skipping incident', {
        spaceId: group.spaceId,
        count: group.count,
      });
      continue;
    }

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
      posted += 1;
      await sleep(config.watchers.postDelayMs);
    } catch (err) {
      alertLog.warn('post failed', {
        err,
        channel,
        spaceId: group.spaceId,
        count: group.count,
      });
    }
  }

  // Advance the cursor to the newest alert we just processed
  const newest = alerts[alerts.length - 1].timestamp;
  if (newest) state.set(STATE_ALERTS, newest);

  alertLog.debug('tick complete', { posted, skipped, cursor: newest });
}

async function pollCases(client, state, spaceNameCache) {
  const cursors = state.get(STATE_CASES, {});

  for (const spaceId of config.watchers.cases.spaces) {
    const spaceLog = caseLog.child({ spaceId });
    const channel = channelFor(spaceId);
    if (!channel) {
      spaceLog.debug('no channel routed for space - skipping');
      continue;
    }

    let cases;
    try {
      cases = await serviceClient.findRecentCases(spaceId, 25);
    } catch (err) {
      spaceLog.error('case query failed - cursor not advanced', { err });
      continue;
    }

    const since = cursors[spaceId] || null;

    // First run for this space: start from newest, don't backfill (cases are desc)
    if (!since) {
      cursors[spaceId] = cases.length ? cases[0].created_at : new Date().toISOString();
      spaceLog.info('no cursor found - watching from now', { from: cursors[spaceId] });
      continue;
    }

    // Keep only cases newer than our cursor, then post oldest-first
    const fresh = cases
      .filter((c) => new Date(c.created_at) > new Date(since))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    if (!fresh.length) continue;
    spaceLog.info('new cases', { count: fresh.length, since });

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
        await sleep(config.watchers.postDelayMs);
      } catch (err) {
        spaceLog.warn('post failed', { err, channel, caseId: c.id });
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
    log.info('watchers disabled via config');
    return () => {};
  }
  if (!serviceClient) {
    log.warn('ELASTIC_SERVICE_API_KEY not set - watchers cannot run', {
      remedy: 'set ELASTIC_SERVICE_API_KEY in .env, or WATCHERS_ENABLED=false to silence this',
    });
    return () => {};
  }
  if (!config.watchers.defaultChannel && Object.keys(config.watchers.channelRouting).length === 0) {
    log.warn('no channel routing configured - nothing will be posted', {
      remedy: 'set DEFAULT_CHANNEL or fill in config.watchers.channelRouting',
    });
  }

  const client = app.client;
  const spaceNameCache = new Map();
  let running = false;

  const tick = async () => {
    if (running) {
      log.warn('previous tick still running - skipping this interval', {
        pollIntervalMs: config.watchers.pollIntervalMs,
      });
      return;
    }
    running = true;
    const started = Date.now();
    try {
      if (config.watchers.alerts.enabled) await pollAlerts(client, state, spaceNameCache);
      if (config.watchers.cases.enabled) await pollCases(client, state, spaceNameCache);
      log.debug('tick complete', { ms: Date.now() - started });
    } catch (err) {
      log.error('tick failed', { err, ms: Date.now() - started });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, config.watchers.pollIntervalMs);
  tick(); // run once immediately
  log.info('watchers started', {
    pollIntervalMs: config.watchers.pollIntervalMs,
    alerts: config.watchers.alerts.enabled,
    cases: config.watchers.cases.enabled,
    caseSpaces: config.watchers.cases.spaces,
  });
  return () => clearInterval(timer);
}

module.exports = { startWatchers };