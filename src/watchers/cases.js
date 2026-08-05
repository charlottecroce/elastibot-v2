'use strict';

const config = require('../../config');
const { caseUrl, newCaseBlocks } = require('../services/format');
const { STATE_KEYS } = require('../constants');
const { logger } = require('../util/logger');

/*
 * The case watcher.
 *
 * Polls the Kibana Cases _find API per configured space and posts anything
 * created since the saved per-space cursor. Cases come back newest-first, so we
 * filter then re-sort ascending to post in the order they happened
 *
 * `cursors` is a copy of the stored object, so mutating it here is local until
 * it goes back through state.set
 */

const log = logger.child({ scope: 'watcher:cases' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} deps  same shape as pollAlerts
 * @returns {Promise<{posted:number,failed:number}>}
 */
async function pollCases({ slack, state, elastic, spaces, channelFor }) {
  const result = { posted: 0, failed: 0 };
  const perPage = config.watchers.cases.perPage;
  const cursors = state.get(STATE_KEYS.CASES_LAST_TS, {});
  let cursorsChanged = false;

  for (const spaceId of config.watchers.cases.spaces) {
    const spaceLog = log.child({ spaceId });
    const channel = channelFor(spaceId);
    if (!channel) {
      spaceLog.debug('no channel routed for space - skipping');
      continue;
    }

    let cases;
    try {
      cases = await elastic.findRecentCases(spaceId, perPage);
    } catch (err) {
      spaceLog.error('case query failed - cursor not advanced', { err });
      continue;
    }

    const since = cursors[spaceId] || null;

    // First run for this space: start from newest, don't backfill (cases are
    // desc). With no cases at all we fall back to local time, which is a
    // different clock from Kibana's
    if (!since) {
      cursors[spaceId] = cases.length ? cases[0].created_at : new Date().toISOString();
      cursorsChanged = true;
      spaceLog.info('no cursor found - watching from now', { from: cursors[spaceId] });
      continue;
    }

    // Keep only cases newer than our cursor, then post oldest-first
    const fresh = cases
      .filter((c) => new Date(c.created_at) > new Date(since))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    if (!fresh.length) continue;
    spaceLog.info('new cases', { count: fresh.length, since });

    if (fresh.length >= perPage) {
      spaceLog.warn('every case on the page was new - some may have been missed', {
        perPage,
        remedy: 'raise WATCH_CASES_PER_PAGE or lower WATCH_POLL_MS for this space',
      });
    }

    const spaceName = await spaces.getName(spaceId, elastic);

    for (const c of fresh) {
      try {
        await slack.chat.postMessage({
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
        result.posted += 1;
        await sleep(config.watchers.postDelayMs);
      } catch (err) {
        result.failed += 1;
        spaceLog.warn('post failed', { err, channel, caseId: c.id });
      }
    }

    cursors[spaceId] = fresh[fresh.length - 1].created_at;
    cursorsChanged = true;
  }

  // Only write when something actually moved
  if (cursorsChanged) state.set(STATE_KEYS.CASES_LAST_TS, cursors);

  log.debug('case poll complete', result);
  return result;
}

module.exports = { pollCases };