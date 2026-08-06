'use strict';

const { incidentMessage } = require('./incidentBlocks');
const { logger } = require('../util/logger');

/*
 * Re-render one incident's message in place.
 *
 * Lives here rather than in watchers/alerts.js because both the watcher (new
 * alerts folded in) and the button handlers in commands/case.js (a case made,
 * alerts attached, a claim taken) need it, and a command module requiring the
 * watcher would be backwards coupling. There should be exactly one place that
 * knows how to put an incident on screen
 */

const log = logger.child({ scope: 'incident:render' });

/** Slack error codes meaning the message we wanted to update is gone */
const MESSAGE_GONE = new Set(['message_not_found', 'channel_not_found']);

function slackErrorCode(err) {
  return err?.data?.error || err?.code || null;
}

/**
 * @param {object} slack       Bolt web client
 * @param {object} incidents   IncidentStore
 * @param {string} key         incident key
 * @param {object} [opts]
 * @param {boolean} [opts.repostIfGone] repost when the message was deleted,
 *   instead of giving up. The watcher wants this; a button click does not -
 *   a click on a deleted message can't happen, so a 'gone' there means the
 *   record is stale and reposting would be noise
 * @returns {Promise<object|null>} the record, or null if nothing was rendered
 */
async function renderIncident(slack, incidents, key, opts = {}) {
  const rec = incidents.get(key);
  if (!rec || !rec.messageTs) return null;

  // The pending breakdown comes off the record, not off whatever batch
  // triggered this render - otherwise a pending alert left over from an earlier
  // tick is missing from the count the analyst reads
  const pending = incidents.pending(rec);
  const msg = incidentMessage(rec, pending, {
    pendingRuleCounts: incidents.ruleCountsFor(rec, pending),
  });

  try {
    await slack.chat.update({ channel: rec.channel, ts: rec.messageTs, ...msg });
    return rec;
  } catch (err) {
    const code = slackErrorCode(err);

    if (opts.repostIfGone && MESSAGE_GONE.has(code)) {
      // Somebody deleted the message. The record is still the source of truth
      // for what is on the case, so repost rather than dropping the incident -
      // otherwise the next alert starts a fresh one and offers a second case
      log.warn('incident message is gone - reposting', { key, code });
      const reposted = await slack.chat.postMessage({ channel: rec.channel, ...msg });
      return incidents.setMessage(key, { channel: rec.channel, messageTs: reposted.ts });
    }

    log.warn('could not re-render incident message', { key, code, err });
    return null;
  }
}

module.exports = { renderIncident, slackErrorCode, MESSAGE_GONE };