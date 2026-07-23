'use strict';

const config = require('../../config');
const { createElasticClient } = require('../elastic');
const { buildCaseTitle, monthYearTag } = require('../naming');
const { caseUrl } = require('./format');

/**
 * A friendly error whose message is safe to output into Slack
 */
class UserFacingError extends Error {}

/** Format an ECS field for the description: join arrays, fall back to N/A */
function fmtField(value) {
  if (Array.isArray(value)) value = value.filter(Boolean).join(', ');
  if (value === undefined || value === null || value === '') return 'N/A';
  return String(value);
}

/** Turn an axios error into a user-friendly message */
function describeAxiosError(err, context) {
  const status = err?.response?.status;
  const body = err?.response?.data;
  const reason =
    (body && (body.message || body.error?.reason || body.error)) || err.message;
  if (status === 401 || status === 403) {
    return new UserFacingError(
      `${context}: Elastic rejected your API key (${status}). ` +
        'Re-run `/start` to register a valid key with the right permissions.'
    );
  }
  if (status === 404) {
    return new UserFacingError(`${context}: not found (404). ${reason || ''}`.trim());
  }
  return new UserFacingError(`${context}: ${reason || 'request failed'}`.trim());
}

/**
 * Create a case from an alert
 *
 * @param {string} apiKey    // the analyst's Elastic API key
 * @param {string} alertId
 * @returns {Promise<{caseId,title,spaceId,spaceName,ruleName,owner,link}>}
 */
async function createCaseForAlert(apiKey, alertId) {
  const client = createElasticClient(apiKey);

  let alert;
  try {
    alert = await client.getAlertById(alertId);
  } catch (err) {
    throw describeAxiosError(err, 'Looking up alert');
  }
  if (!alert) {
    throw new UserFacingError(
      `No alert found with ID \`${alertId}\` in \`${config.elastic.alertsIndex}\`.`
    );
  }

  const spaceName = await client.getSpaceName(alert.spaceId);
  const title = buildCaseTitle(spaceName, alert.ruleName, {
    truncateRuleWords: config.naming.truncateRuleWords,
  });

  let created;
  try {
    created = await client.createCase(alert.spaceId, {
      title,
      description:
        `Created via Elastibot from Slack for alert \`${alertId}\` ` +
        `(rule: ${alert.ruleName}).\n\n` +
        `user.name: \`${fmtField(alert.userName)}\`\n` +
        `host.name: \`${fmtField(alert.hostName)}\``,
      tags: ['elastibot', monthYearTag()],
      connector: { id: 'none', name: 'none', type: '.none', fields: null },
      settings: { syncAlerts: true },
      owner: alert.owner,
    });
  } catch (err) {
    throw describeAxiosError(err, 'Creating case');
  }

  const caseId = created.id;

  try {
    await client.attachAlert(alert.spaceId, caseId, {
      type: 'alert',
      alertId: alert.id,
      index: alert.index,
      rule: { id: alert.ruleId, name: alert.ruleName },
      owner: alert.owner,
    });
  } catch (err) {
    // Case exists but the attach failed
    throw new UserFacingError(
      `Case *${title}* (\`${caseId}\`) was created, but attaching the alert failed: ` +
        `${describeAxiosError(err, 'attach').message}`
    );
  }

  return {
    caseId,
    title,
    spaceId: alert.spaceId,
    spaceName,
    ruleName: alert.ruleName,
    owner: alert.owner,
    link: caseUrl(alert.spaceId, caseId, alert.owner),
  };
}

/**
 * Attach an alert to an existing case. The case and alert must live in the same space
 *
 * @returns {Promise<{caseId,alertId,ruleName,link}>}
 */
async function addAlertToCase(apiKey, caseId, alertId) {
  const client = createElasticClient(apiKey);

  let alert;
  try {
    alert = await client.getAlertById(alertId);
  } catch (err) {
    throw describeAxiosError(err, 'Looking up alert');
  }
  if (!alert) {
    throw new UserFacingError(`No alert found with ID \`${alertId}\`.`);
  }

  try {
    await client.attachAlert(alert.spaceId, caseId, {
      type: 'alert',
      alertId: alert.id,
      index: alert.index,
      rule: { id: alert.ruleId, name: alert.ruleName },
      owner: alert.owner,
    });
  } catch (err) {
    const e = describeAxiosError(err, 'Adding alert to case');
    if (/not found/i.test(e.message)) {
      throw new UserFacingError(
        `Could not find case \`${caseId}\` in space \`${alert.spaceId}\`. ` +
          'Double-check the case ID from Elastibot\'s creation message.'
      );
    }
    throw e;
  }

  return {
    caseId,
    alertId: alert.id,
    ruleName: alert.ruleName,
    link: caseUrl(alert.spaceId, caseId, alert.owner),
  };
}

module.exports = { createCaseForAlert, addAlertToCase, UserFacingError };