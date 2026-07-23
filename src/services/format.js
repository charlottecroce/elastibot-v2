'use strict';

const config = require('../../config');

/** Build a Kibana link to a case, respecting space + solution. */
function caseUrl(spaceId, caseId, owner) {
  const base = (config.elastic.kibanaUrl || '').replace(/\/$/, '');
  const sp = spaceId && spaceId !== 'default' ? `/s/${encodeURIComponent(spaceId)}` : '';
  const id = encodeURIComponent(caseId);
  if (owner === 'securitySolution') return `${base}${sp}/app/security/cases/${id}`;
  if (owner === 'observability') return `${base}${sp}/app/observability/cases/${id}`;
  return `${base}${sp}/app/management/insightsAndAlerting/cases/${id}`;
}

/** Escape the few characters that are special in Slack mrkdwn links/text. */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Success message after a case is created. */
function caseCreatedBlocks({ title, caseId, spaceName, ruleName, link, slackUserId }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:white_check_mark: *Case created* by <@${slackUserId}>\n*<${link}|${esc(title)}>*`,
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `*Case ID:* \`${esc(caseId)}\`` },
        { type: 'mrkdwn', text: `*Space:* ${esc(spaceName)}` },
        { type: 'mrkdwn', text: `*Rule:* ${esc(ruleName)}` },
      ],
    },
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
}

/** Success message after an alert is added to an existing case. */
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

/** New-alert notification posted by the watcher, with a "Create case" button. */
function newAlertBlocks({ alertId, ruleName, severity, spaceName, timestamp }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:rotating_light: *New alert* — ${esc(ruleName)}`,
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `*Severity:* ${esc(severity)}` },
        { type: 'mrkdwn', text: `*Space:* ${esc(spaceName)}` },
        { type: 'mrkdwn', text: `*When:* ${esc(timestamp)}` },
        { type: 'mrkdwn', text: `*Alert ID:* \`${esc(alertId)}\`` },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Create case' },
          action_id: 'create_case_from_alert',
          value: alertId,
        },
      ],
    },
  ];
}

/** New-case notification posted by the watcher. */
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
  newAlertBlocks,
  newCaseBlocks,
};