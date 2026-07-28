'use strict';

const config = require('../../config');

/** Build a Kibana link to a case, respecting space + solution */
function caseUrl(spaceId, caseId, owner) {
  const base = (config.elastic.kibanaUrl || '').replace(/\/$/, '');
  const sp = spaceId && spaceId !== 'default' ? `/s/${encodeURIComponent(spaceId)}` : '';
  const id = encodeURIComponent(caseId);
  if (owner === 'securitySolution') return `${base}${sp}/app/security/cases/${id}`;
  if (owner === 'observability') return `${base}${sp}/app/observability/cases/${id}`;
  return `${base}${sp}/app/management/insightsAndAlerting/cases/${id}`;
}

/** Escape the few characters that are special in Slack mrkdwn links/text */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render a { ruleName: count } map as "Rule A ×3, Rule B ×1" */
function ruleBreakdown(ruleCounts, fallbackRule) {
  if (ruleCounts && Object.keys(ruleCounts).length) {
    return Object.entries(ruleCounts)
      .map(([n, c]) => `${esc(n)} ×${c}`)
      .join(', ');
  }
  return esc(fallbackRule);
}

/** Success message after a case is created (single or grouped alerts) */
function caseCreatedBlocks({
  title,
  caseId,
  spaceName,
  ruleName,
  ruleCounts,
  alertCount = 1,
  warning,
  link,
  slackUserId,
}) {
  const meta = [
    { type: 'mrkdwn', text: `*Case ID:* \`${esc(caseId)}\`` },
    { type: 'mrkdwn', text: `*Space:* ${esc(spaceName)}` },
  ];
  if (alertCount > 1) meta.push({ type: 'mrkdwn', text: `*Alerts:* ${alertCount}` });

  const rulesEl =
    alertCount > 1
      ? { type: 'mrkdwn', text: `*Rules:* ${ruleBreakdown(ruleCounts, ruleName)}` }
      : { type: 'mrkdwn', text: `*Rule:* ${esc(ruleName)}` };

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:white_check_mark: *Case created* by <@${slackUserId}>\n*<${link}|${esc(title)}>*`,
      },
    },
    { type: 'context', elements: meta },
    { type: 'context', elements: [rulesEl] },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Add more alerts with \`/add_alert ${esc(caseId)} <alertID>\``,
        },
      ],
    },
  ];
  if (warning) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:warning: ${esc(warning)}` }],
    });
  }
  return blocks;
}

/** Success message after an alert is added to an existing case */
function alertAddedBlocks({ caseId, alertId, ruleName, link, slackUserId }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `:heavy_plus_sign: <@${slackUserId}> added alert \`${esc(alertId)}\` ` +
          `(${esc(ruleName)}) to case <${link}|${esc(caseId)}>`,
      },
    },
  ];
}

/*
 * Watcher notification. One message per incident: a single alert renders as
 * before; a correlated burst renders as a rollup with a count, rule breakdown
 * and time window. The "Create case" button carries the encoded group descriptor
 */
function alertGroupBlocks({
  count = 1,
  representativeRule,
  ruleCounts,
  topSeverity,
  userName,
  hostName,
  spaceName,
  from,
  to,
  alertId,
  buttonValue,
}) {
  const button = {
    type: 'actions',
    elements: [
      {
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: count > 1 ? `Create case (${count} alerts)` : 'Create case' },
        action_id: 'create_case_from_alert',
        value: buttonValue || alertId,
      },
    ],
  };

  if (count > 1) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `:rotating_light: *${count} related alerts* — user \`${esc(userName)}\` ` +
            `on host \`${esc(hostName)}\``,
        },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `*Top severity:* ${esc(topSeverity)}` },
          { type: 'mrkdwn', text: `*Space:* ${esc(spaceName)}` },
          { type: 'mrkdwn', text: `*Window:* ${esc(from)} → ${esc(to)}` },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*Rules:* ${ruleBreakdown(ruleCounts, representativeRule)}` }],
      },
      button,
    ];
  }

  // Single alert
  const idLine = [];
  if (userName) idLine.push({ type: 'mrkdwn', text: `*User:* \`${esc(userName)}\`` });
  if (hostName) idLine.push({ type: 'mrkdwn', text: `*Host:* \`${esc(hostName)}\`` });
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:rotating_light: *New alert* — ${esc(representativeRule)}` },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `*Severity:* ${esc(topSeverity)}` },
        { type: 'mrkdwn', text: `*Space:* ${esc(spaceName)}` },
        { type: 'mrkdwn', text: `*When:* ${esc(from)}` },
        { type: 'mrkdwn', text: `*Alert ID:* \`${esc(alertId)}\`` },
        ...idLine,
      ],
    },
    button,
  ];
}

/** New-case notification posted by the watcher */
function newCaseBlocks({ title, caseId, spaceName, link, createdBy }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:open_file_folder: *New case* — *<${link}|${esc(title)}>*`,
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `*Case ID:* \`${esc(caseId)}\`` },
        { type: 'mrkdwn', text: `*Space:* ${esc(spaceName)}` },
        { type: 'mrkdwn', text: `*Created by:* ${esc(createdBy || 'unknown')}` },
      ],
    },
  ];
}

module.exports = {
  caseUrl,
  esc,
  caseCreatedBlocks,
  alertAddedBlocks,
  alertGroupBlocks,
  newCaseBlocks,
};