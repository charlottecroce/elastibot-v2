'use strict';

const { ACTIONS } = require('../constants');
const { esc, code, mrkdwnLink, ruleBreakdown } = require('../util/mrkdwn');
const { caseLinkForIncident } = require('./kibanaLinks');

/*
 * The incident message, in its three states.
 *
 *   1. NO CASE          green "Create case"
 *   2. CASE, SETTLED    no buttons - the case summary line links the case
 *   3. CASE, PENDING    green "Add N new alerts to case", plus a section
 *                       listing what isn't on the case yet as ready-to-run
 *                       /add_alert commands
 *
 * The same message is re-rendered in place with chat.update as alerts arrive
 * and as the case is made, so an analyst reading a two-hour-old message in the
 * channel sees current state, not state at post time.
 *
 */

/** Past this many, the pending id list is noise rather than something to
 *  reconcile by hand */
const MAX_PENDING_IDS_SHOWN = 10;

/*
 * Fence-safe text. Inside a ``` block Slack does NOT interpret mrkdwn, so this
 * takes no esc() - same convention as format.js#plain. A stray backtick would
 * close the fence early and spill the remaining commands into the message as
 * prose, so it gets stripped
 */
function fenceSafe(s) {
  return String(s ?? '').replace(/[`\r\n]+/g, '');
}

/** "`jsmith` (+SYSTEM, svc_backup)" - the machine identities folded in by
 *  grouping.js are shown, not hidden, or the merge looks like a bug */
function identityLine({ primaryUser, userNames = [] }) {
  if (!primaryUser && !userNames.length) return null;
  const others = userNames.filter((u) => u !== primaryUser);
  const base = primaryUser ? code(primaryUser) : '_no user_';
  if (!others.length) return base;
  return `${base} _(+${others.map((u) => esc(u)).join(', ')})_`;
}

function createCaseButton(rec, alertCount) {
  return {
    type: 'button',
    style: 'primary',
    text: {
      type: 'plain_text',
      text: alertCount > 1 ? `Create case (${alertCount} alerts)` : 'Create case',
      emoji: true,
    },
    action_id: ACTIONS.CREATE_CASE_FROM_ALERT,
    value: rec.key,
  };
}

function addAlertsButton(rec, pendingCount) {
  return {
    type: 'button',
    style: 'primary',
    text: {
      type: 'plain_text',
      text: `Add ${pendingCount} new alert${pendingCount === 1 ? '' : 's'} to case`,
      emoji: true,
    },
    action_id: ACTIONS.ADD_ALERTS_TO_CASE,
    value: rec.key,
  };
}

/**
 * The context line naming the case and how much of the incident is on it.
 *
 *
 * mrkdwnLink degrades to the bare title when there is no usable link, rather
 * than rendering the literal text "<undefined|SO-073026-Malware>"
 */
function caseSummaryBlock(rec, caseLink, totalCount) {
  const onCase = (rec.attachedIds || []).length;
  return {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text:
          `:open_file_folder: *${mrkdwnLink(caseLink, rec.caseTitle || rec.caseId)}* — ` +
          `${onCase} of ${totalCount} alert${totalCount === 1 ? '' : 's'} attached`,
      },
    ],
  };
}

/**
 * The "N new alerts since the case was created" section plus the commands that
 * attach them by hand.
 *
 * Whole commands, not bare ids. The button is the happy path; this block is
 * what gets used when the button fails, and hand-assembling
 * `/add_alert <caseID> <alertID>` around a UUID at 3am is how the wrong alert
 * ends up on the case. Slack puts a copy affordance on a fenced block and
 * leaves its contents unformatted, so the whole list survives a paste.
 *
 * A `section` and not a `context`: context text renders small and grey, and on
 * mobile it wraps mid-id. Slack caps a section's text at 3000 chars - ten
 * UUID-length commands is roughly 500, so MAX_PENDING_IDS_SHOWN keeps this well
 * clear without needing a length check here
 *
 * @param {object} rec            incident record - needed for caseId
 * @param {string[]} pendingIds
 * @param {object} [pendingRuleCounts]
 */
function pendingBlocks(rec, pendingIds, pendingRuleCounts) {
  const pendingCount = pendingIds.length;
  const breakdown = pendingRuleCounts ? `\n${ruleBreakdown(pendingRuleCounts)}` : '';

  const shown = pendingIds.slice(0, MAX_PENDING_IDS_SHOWN);
  const more = pendingCount - shown.length;

  const commands = shown.map((id) => `/add_alert ${fenceSafe(rec.caseId)} ${fenceSafe(id)}`);

  const blocks = [
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `:new: *${pendingCount} new alert${pendingCount === 1 ? '' : 's'} ` +
          `since the case was created*${breakdown}`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`\n${commands.join('\n')}\n\`\`\`` },
    },
  ];

  if (more > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_+${more} more not listed — use the button_` }],
    });
  }

  return blocks;
}

/**
 * Build the message for an incident record.
 *
 * @param {object} rec           incident record from incidents.js
 * @param {string[]} pendingIds  rec.alertIds minus rec.attachedIds
 * @param {object} [opts]
 * @param {object} [opts.pendingRuleCounts] rule breakdown for just the pending
 *   alerts. Optional - without it the pending section shows a count only
 * @returns {{text: string, blocks: Array}}
 */
function incidentMessage(rec, pendingIds = [], opts = {}) {
  const alertIds = rec.alertIds || [];
  const count = alertIds.length;
  const isBurst = count > 1;

  const hasCase = Boolean(rec.caseId);
  const caseLink = caseLinkForIncident(rec);

  const pendingCount = pendingIds.length;
  const showPending = hasCase && pendingCount > 0;

  const who = identityLine(rec);

  const header = isBurst
    ? `:rotating_light: *${count} related alerts*` +
      (who ? ` — ${who}` : '') +
      (rec.hostName ? ` on host ${code(rec.hostName)}` : '')
    : `:rotating_light: *New alert* — ${esc(rec.representativeRule)}`;

  const meta = [
    { type: 'mrkdwn', text: `*Top severity:* ${esc(rec.topSeverity)}` },
    { type: 'mrkdwn', text: `*Space:* ${esc(rec.spaceName || rec.spaceId)}` },
  ];
  if (isBurst) {
    meta.push({ type: 'mrkdwn', text: `*Window:* ${esc(rec.from)} → ${esc(rec.to)}` });
  } else {
    meta.push({ type: 'mrkdwn', text: `*When:* ${esc(rec.from)}` });
    if (alertIds.length) {
      meta.push({ type: 'mrkdwn', text: `*Alert ID:* ${code(alertIds[0])}` });
    }
    if (rec.hostName) meta.push({ type: 'mrkdwn', text: `*Host:* ${code(rec.hostName)}` });
    if (who) meta.push({ type: 'mrkdwn', text: `*User:* ${who}` });
  }

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: header } },
    { type: 'context', elements: meta },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*Rules:* ${ruleBreakdown(rec.ruleCounts, rec.representativeRule)}`,
        },
      ],
    },
  ];

  if (hasCase) blocks.push(caseSummaryBlock(rec, caseLink, count));

  /*
   * The pending section. This is the part that stops the second analyst
   * opening a second case: the message says out loud that a case exists, which
   * alerts are on it, and which aren't yet
   */
  if (showPending) blocks.push(...pendingBlocks(rec, pendingIds, opts.pendingRuleCounts));

  /*
   * Actions. create the case, or attach what isn't on
   * it yet. A settled incident gets no actions block at all, which is the right
   * shape: there is nothing left to do to it from Slack.
   *
   */
  const elements = [];
  if (hasCase) {
    if (showPending) elements.push(addAlertsButton(rec, pendingCount));
  } else {
    elements.push(createCaseButton(rec, count));
  }
  if (elements.length) blocks.push({ type: 'actions', elements });

  // A claim in flight: somebody is clicking right now. Cosmetic - the claim in
  // incidents.js is what actually blocks the second case - but it stops the
  // second analyst wondering why nothing happened
  if (rec.claim) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `:hourglass_flowing_sand: <@${rec.claim.by}> is creating a case…`,
        },
      ],
    });
  }

  const text = isBurst
    ? `${count} related alerts on ${rec.hostName || 'unknown host'}: ${rec.representativeRule}`
    : `New alert: ${rec.representativeRule}`;

  return { text, blocks };
}

module.exports = {
  incidentMessage,
  identityLine,
  MAX_PENDING_IDS_SHOWN,
  // Re-exported for the modules that already imported it from here
  ruleBreakdown,
};