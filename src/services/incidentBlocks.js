'use strict';

const { ACTIONS } = require('../constants');
const { esc, code, mrkdwnLink, ruleBreakdown } = require('../util/mrkdwn');
const { caseLinkForIncident } = require('./kibanaLinks');

/*
 * The incident message, in its three states.
 *
 *   1. NO CASE          green "Create case"
 *   2. CASE, SETTLED    plain "View case" - every alert shown is on the case
 *   3. CASE, PENDING    plain "View case" + green "Add N new alerts to case",
 *                       plus a section listing what isn't on the case yet
 *
 * The same message is re-rendered in place with chat.update as alerts arrive
 * and as the case is made, so an analyst reading a two-hour-old message in the
 * channel sees current state, not state at post time.
 *
 */

/** Past this many, the pending id list is noise rather than something to
 *  reconcile by hand */
const MAX_PENDING_IDS_SHOWN = 10;

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

/**
 * A link button, not an action. It opens Kibana directly instead of round
 * tripping through the bot, so it works for anyone in the channel whether or
 * not they have run /start.
 *
 * WHY THIS TAKES caseLink AS AN ARGUMENT INSTEAD OF READING rec.caseLink:
 * a Slack button whose `url` is undefined - or is anything other than an
 * absolute http(s) URL - is not rejected. Slack drops the field, renders the
 * button, and clicking it does nothing, with no error on either side. So the
 * url is resolved by the caller through caseLinkForIncident (which derives it
 * from spaceId + caseId when the stored copy is missing or unusable) and this
 * returns null rather than ever emitting a button that can't be clicked.
 *
 * Slack still delivers an interaction event for url buttons, so the action_id
 * needs a registered no-op ack or Bolt logs an unhandled action on every single
 * click - see commands/case.js
 *
 * @param {object} rec
 * @param {string|null} caseLink absolute http(s) url from caseLinkForIncident
 * @returns {object|null} the button, or null if there is no link to give it
 */
function viewCaseButton(rec, caseLink) {
  if (!caseLink) return null;
  return {
    type: 'button',
    text: { type: 'plain_text', text: 'View case', emoji: true },
    url: caseLink,
    action_id: ACTIONS.VIEW_CASE,
    // Deliberately no `value`: a link button carries no state, the no-op
    // handler never reads one, and rec.caseId is already in the url
    accessibility_label: `Open case ${rec.caseTitle || rec.caseId} in Kibana`,
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

/** The context line naming the case and how much of the incident is on it */
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

/** The "N new alerts since the case was created" section plus its id list */
function pendingBlocks(pendingIds, pendingRuleCounts) {
  const pendingCount = pendingIds.length;
  const breakdown = pendingRuleCounts ? `\n${ruleBreakdown(pendingRuleCounts)}` : '';

  const shown = pendingIds.slice(0, MAX_PENDING_IDS_SHOWN);
  const more = pendingCount - shown.length;

  return [
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
      // Ids are what an analyst needs to reconcile by hand if the button fails
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: shown.map(code).join(' ') + (more > 0 ? ` _+${more} more_` : ''),
        },
      ],
    },
  ];
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
  // Resolved once and threaded through, so the button and the summary line can
  // never disagree about whether there is a link
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
  if (showPending) blocks.push(...pendingBlocks(pendingIds, opts.pendingRuleCounts));

  /*
   * Actions. Order follows the spec: the case first, then what to do about the
   * alerts that aren't on it.
   *
   * Built as a list and only appended if non-empty. Slack rejects an actions
   * block with `elements: []`, and that rejection fails the whole chat.update -
   * so a record with a case but no reachable link would take the entire message
   * down with it rather than just losing one button
   */
  const elements = [];
  if (hasCase) {
    const view = viewCaseButton(rec, caseLink);
    if (view) elements.push(view);
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
  viewCaseButton,
  MAX_PENDING_IDS_SHOWN,
  // Re-exported for the modules that already imported it from here
  ruleBreakdown,
};