'use strict';

const { ACTIONS, UNKNOWN_RULE } = require('../constants');

/*
 * The incident message, in its three states.
 *
 *   1. NO CASE          green "Create case"
 *   2. CASE, SETTLED    grey "View case" - every alert shown is on the case
 *   3. CASE, PENDING    grey "View case" + red "Add N new alerts to case",
 *                       plus a section listing what isn't on the case yet
 *
 * The same message is re-rendered in place with chat.update as alerts arrive
 * and as the case is made, so an analyst reading a two-hour-old message in the
 * channel sees current state, not state at post time
 *
 */

/** Slack mrkdwn escaping */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ruleBreakdown(ruleCounts, fallback) {
  const entries = Object.entries(ruleCounts || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return esc(fallback || UNKNOWN_RULE);
  return entries.map(([name, n]) => `${esc(name)} ×${n}`).join(', ');
}

/** "jsmith (+SYSTEM, svc_backup)" - the machine identities folded in by
 *  grouping.js are shown, not hidden, or the merge looks like a bug */
function identityLine({ primaryUser, userNames = [] }) {
  if (!primaryUser && !userNames.length) return null;
  const others = userNames.filter((u) => u !== primaryUser);
  const base = primaryUser ? `\`${esc(primaryUser)}\`` : '_no user_';
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

/*
 * A link button, not an action. It opens Kibana directly instead of round
 * tripping through the bot, so it works for anyone in the channel whether or
 * not they have run /start. Slack still delivers an interaction event for url
 * buttons, so it needs an action_id registered to a no-op ack or Bolt logs an
 * unhandled-action warning on every click - see commands/case.js
 */
function viewCaseButton(rec) {
  return {
    type: 'button',
    text: { type: 'plain_text', text: 'View case', emoji: true },
    url: rec.caseLink,
    action_id: ACTIONS.VIEW_CASE,
    value: rec.caseId,
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
  const count = rec.alertIds.length;
  const isBurst = count > 1;
  const hasCase = Boolean(rec.caseId);
  const pendingCount = pendingIds.length;
  const showPending = hasCase && pendingCount > 0;

  const who = identityLine(rec);

  const header = isBurst
    ? `:rotating_light: *${count} related alerts*` +
      (who ? ` — ${who}` : '') +
      (rec.hostName ? ` on host \`${esc(rec.hostName)}\`` : '')
    : `:rotating_light: *New alert* — ${esc(rec.representativeRule)}`;

  const meta = [
    { type: 'mrkdwn', text: `*Top severity:* ${esc(rec.topSeverity)}` },
    { type: 'mrkdwn', text: `*Space:* ${esc(rec.spaceName || rec.spaceId)}` },
  ];
  if (isBurst) {
    meta.push({ type: 'mrkdwn', text: `*Window:* ${esc(rec.from)} → ${esc(rec.to)}` });
  } else {
    meta.push({ type: 'mrkdwn', text: `*When:* ${esc(rec.from)}` });
    meta.push({ type: 'mrkdwn', text: `*Alert ID:* \`${esc(rec.alertIds[0])}\`` });
    if (rec.hostName) meta.push({ type: 'mrkdwn', text: `*Host:* \`${esc(rec.hostName)}\`` });
    if (who) meta.push({ type: 'mrkdwn', text: `*User:* ${who}` });
  }

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: header } },
    { type: 'context', elements: meta },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `*Rules:* ${ruleBreakdown(rec.ruleCounts, rec.representativeRule)}` },
      ],
    },
  ];

  if (hasCase) {
    const onCase = rec.attachedIds.length;
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            `:open_file_folder: *<${rec.caseLink}|${esc(rec.caseTitle || rec.caseId)}>* — ` +
            `${onCase} of ${count} alert${count === 1 ? '' : 's'} attached`,
        },
      ],
    });
  }

  /*
   * The pending section. This is the part that stops the second analyst
   * opening a second case: the message says out loud that a case exists, which
   * alerts are on it, and which aren't yet
   */
  if (showPending) {
    blocks.push({ type: 'divider' });

    const breakdown = opts.pendingRuleCounts
      ? `\n${ruleBreakdown(opts.pendingRuleCounts)}`
      : '';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `:new: *${pendingCount} new alert${pendingCount === 1 ? '' : 's'} ` +
          `since the case was created*${breakdown}`,
      },
    });

    // Ids are what an analyst needs to reconcile by hand if the button fails.
    // Past a handful the list is noise, so it is capped
    const shown = pendingIds.slice(0, 10);
    const more = pendingCount - shown.length;
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            shown.map((id) => `\`${esc(id)}\``).join(' ') +
            (more > 0 ? ` _+${more} more_` : ''),
        },
      ],
    });
  }

  // Actions. Order follows the spec: the case first, then what to do about the
  // alerts that aren't on it
  const elements = hasCase
    ? [viewCaseButton(rec), ...(showPending ? [addAlertsButton(rec, pendingCount)] : [])]
    : [createCaseButton(rec, count)];

  blocks.push({ type: 'actions', elements });

  // A claim in flight: somebody is clicking right now. Cosmetic - the claim in
  // incidents.js is what actually blocks the second case - but it stops the
  // second analyst wondering why nothing happened
  if (rec.claim) {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `:hourglass_flowing_sand: <@${rec.claim.by}> is creating a case…` },
      ],
    });
  }

  const text = isBurst
    ? `${count} related alerts on ${rec.hostName || 'unknown host'}: ${rec.representativeRule}`
    : `New alert: ${rec.representativeRule}`;

  return { text, blocks };
}

module.exports = { incidentMessage, identityLine, ruleBreakdown };