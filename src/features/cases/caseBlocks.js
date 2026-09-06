'use strict';

const {
  esc,
  fenceSafeToken,
  mrkdwnLink,
  ruleBreakdown,
} = require('../../core/util/mrkdwn');

/*
 * The case-related Slack messages: the confirmation after a case is created,
 * after an alert is added to one, and the watcher's new-case notification.
 *
 * The other half of the old services/format.js - the /stats table helpers and
 * statsBlocks - went to features/stats/statsBlocks.js. The two halves never
 * shared a function, which is what made the split clean.
 *
 * Anything rendered inside a ``` fence goes through fenceSafe/fenceSafeToken
 * (core/util/mrkdwn), not esc: Slack does not interpret mrkdwn in a fence, so
 * the hazard is a stray backtick closing it early rather than an unescaped
 * angle bracket.
 */

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
        // mrkdwnLink, not string interpolation: a result object without `link`
        // used to render the literal text "<undefined|SO-073026-Malware>"
        text: `:white_check_mark: *Case created* by <@${slackUserId}>\n*${mrkdwnLink(link, title)}*`,
      },
    },
    { type: 'context', elements: meta },
    { type: 'context', elements: [rulesEl] },
    {
      /*
       * The template with the real case id already in it, inside a fence.
       *
       * Not esc(): Slack does not interpret mrkdwn inside a fence, and a
       * backtick in the id would close it early. fenceSafeToken specifically,
       * because this is a runnable command and the id is one of its arguments -
       * the old plain() here collapsed a backtick to a space, which would have
       * split the id in two and pointed the command at something else
       */
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Add more alerts:\n\`\`\`\n/add_alert ${fenceSafeToken(caseId, { max: 128 })} <alertID>\n\`\`\``,
      },
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
          `(${esc(ruleName)}) to case ${mrkdwnLink(link, caseId)}`,
      },
    },
  ];
}

/** New-case notification posted by the watcher */
function newCaseBlocks({ title, caseId, spaceName, link, createdBy }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:open_file_folder: *New case* — *${mrkdwnLink(link, title)}*`,
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
  caseCreatedBlocks,
  alertAddedBlocks,
  newCaseBlocks,
};