'use strict';

const config = require('../../config');
const { createElasticClient } = require('../elastic');
const { buildCaseTitle, monthYearTag } = require('../naming');
const { caseUrl } = require('./format');
const { getSpaceName } = require('./spaceService');
const { ALERT_STATUS_FOR_CASE, DEFAULT_SPACE } = require('../constants');
const { UserFacingError, describeAxiosError } = require('../util/errors');
const { logger } = require('../util/logger');

/*
 * Case creation and alert attachment.
 *
 */

const log = logger.child({ scope: 'service:case' });

/** Format an ECS field for the description: join arrays, fall back to N/A */
function fmtField(value) {
  if (Array.isArray(value)) value = value.filter(Boolean).join(', ');
  if (value === undefined || value === null || value === '') return 'N/A';
  return String(value);
}

/** Drop duplicate alerts by id, keeping order */
function dedupeById(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    if (a && a.id && !seen.has(a.id)) {
      seen.add(a.id);
      out.push(a);
    }
  }
  return out;
}

/** Key with the highest count in a { key: count } map */
function topKey(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Create one case from one OR many alerts (already fetched), in the shared space
 * Title uses the most common rule. Alerts are attached in per-rule batches (the
 * comments API takes one rule per alert-comment but accepts an array of alert ids)
 *
 * syncAlerts is on, so the case status drives the status of every alert attached
 * to it from here on - closing the case closes its alerts
 */
async function createCaseFromAlerts(client, alerts) {
  const spaceId = alerts[0].spaceId || DEFAULT_SPACE;
  // Shared TTL cache rather than a fresh Kibana round trip per case. The name
  // goes in the case title and changes about once a year
  const spaceName = await getSpaceName(spaceId, client);

  const ruleCounts = {};
  const ownerCounts = {};
  for (const a of alerts) {
    const rn = a.ruleName || 'Unknown Rule';
    ruleCounts[rn] = (ruleCounts[rn] || 0) + 1;
    const ow = a.owner || config.elastic.defaultOwner;
    ownerCounts[ow] = (ownerCounts[ow] || 0) + 1;
  }
  const representativeRule = topKey(ruleCounts) || 'Unknown Rule';
  const owner = topKey(ownerCounts) || config.elastic.defaultOwner;
  const repUser = alerts.find((a) => a.userName)?.userName;
  const repHost = alerts.find((a) => a.hostName)?.hostName;

  /*
   * Pin the title's date to a configured zone. Without this, datePart uses the
   * node process's local timezone, so the same alert yields a different case
   * name depending on which region the bot happens to run in
   */
  const title = buildCaseTitle(spaceName, representativeRule, {
    truncateRuleWords: config.naming.truncateRuleWords,
    timeZone: config.naming.timeZone,
  });

  const isGroup = alerts.length > 1;
  const times = alerts.map((a) => a.timestamp).filter(Boolean).sort();
  const rangeLine =
    isGroup && times.length
      ? `\ntime range: \`${times[0]}\` — \`${times[times.length - 1]}\``
      : '';
  const ruleSummary = Object.entries(ruleCounts)
    .map(([n, c]) => `${n} ×${c}`)
    .join(', ');

  // Single alert gets a plain description. only a real group mentions grouping
  const description = isGroup
    ? `Created via Elastibot from Slack - ${alerts.length} alerts grouped by user + host.\n\n` +
      `user.name: \`${fmtField(repUser)}\`\n` +
      `host.name: \`${fmtField(repHost)}\`\n\n` +
      `alerts: ${ruleSummary}${rangeLine}`
    : `Created via Elastibot from Slack for alert \`${alerts[0].id}\` (rule: ${representativeRule}).\n\n` +
      `user.name: \`${fmtField(repUser)}\`\n` +
      `host.name: \`${fmtField(repHost)}\``;

  let created;
  try {
    created = await client.createCase(spaceId, {
      title,
      description,
      tags: ['elastibot', monthYearTag(new Date(), config.naming.timeZone)],
      connector: { id: 'none', name: 'none', type: '.none', fields: null },
      settings: { syncAlerts: true },
      owner,
    });
  } catch (err) {
    throw describeAxiosError(err, 'Creating case');
  }
  const caseId = created.id;

  // Attach alerts in per-rule batches
  const byRule = new Map();
  for (const a of alerts) {
    const key = a.ruleId || a.ruleName || 'unknown';
    if (!byRule.has(key)) byRule.set(key, []);
    byRule.get(key).push(a);
  }

  let attached = 0;
  const failures = [];
  for (const list of byRule.values()) {
    try {
      await client.attachAlert(spaceId, caseId, {
        type: 'alert',
        alertId: list.map((a) => a.id),
        index: list.map((a) => a.index),
        rule: { id: list[0].ruleId, name: list[0].ruleName },
        owner,
      });
      attached += list.length;
    } catch (err) {
      failures.push(
        `${list[0].ruleName} ×${list.length} (${describeAxiosError(err, 'attach').message})`
      );
    }
  }

  if (attached === 0) {
    throw new UserFacingError(
      `Case *${title}* (\`${caseId}\`) was created, but attaching alerts failed: ${failures.join('; ')}`
    );
  }

  // A partial failure is reported to the analyst in the Slack message, but it
  // also belongs in the log - otherwise the only record of it scrolls away
  if (failures.length) {
    log.warn('some alerts did not attach', {
      caseId,
      spaceId,
      attached,
      failed: alerts.length - attached,
    });
  }

  return {
    caseId,
    title,
    spaceId,
    spaceName,
    owner,
    ruleName: representativeRule,
    ruleCounts,
    alertCount: alerts.length,
    attachedCount: attached,
    warning: failures.length ? `Some alerts didn't attach: ${failures.join('; ')}` : null,
    link: caseUrl(spaceId, caseId, owner),
  };
}

/**
 * /case <alertID> and the singleton "Create case" button
 * Files just the given alert into a case - no sibling gathering. The grouped
 * "Create case" button uses createCaseForGroup to combine a whole incident
 *
 * @param {string} apiKey    // the analyst's Elastic API key
 * @param {string} alertId
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

  return createCaseFromAlerts(client, [alert]);
}

/**
 * The grouped "Create case" button. Re-runs the user+host+time-range query so
 * the case captures the whole burst (and any stragglers) at click time
 */
async function createCaseForGroup(apiKey, { spaceId, userName, hostName, from, to }) {
  const client = createElasticClient(apiKey);

  let alerts;
  try {
    alerts = await client.getRelatedAlerts({
      spaceId,
      userName,
      hostName,
      from,
      to,
      size: config.grouping.maxAlertsPerCase,
    });
  } catch (err) {
    throw describeAxiosError(err, 'Looking up alerts');
  }
  alerts = dedupeById(alerts || []);
  if (!alerts.length) {
    throw new UserFacingError(
      'No alerts found for this group — they may have aged out of the index.'
    );
  }

  /*
   * The query is capped at maxAlertsPerCase. Hitting the cap means the incident
   * was bigger than the case now reflects, which an analyst reading the case
   * later has no way to tell
   */
  if (alerts.length >= config.grouping.maxAlertsPerCase) {
    log.warn('group hit the alert cap - the case may not contain the whole incident', {
      spaceId,
      userName,
      hostName,
      cap: config.grouping.maxAlertsPerCase,
    });
  }

  return createCaseFromAlerts(client, alerts);
}

/**
 * Attach an alert to an existing case. The case and alert must live in the same space
 *
 * We read the case first for its status: Kibana only pushes status to alerts on a
 * case status *change*, so an alert joining an already in-progress/closed case
 * would otherwise stay open. We set it to match once, then syncing takes over
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

  let existingCase;
  try {
    existingCase = await client.getCase(alert.spaceId, caseId);
  } catch (err) {
    const e = describeAxiosError(err, 'Looking up case');
    if (/not found/i.test(e.message)) {
      throw new UserFacingError(
        `Could not find case \`${caseId}\` in space \`${alert.spaceId}\`. ` +
          'Double-check the case ID from Elastibot\'s creation message.'
      );
    }
    throw e;
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
    throw describeAxiosError(err, 'Adding alert to case');
  }

  // Catch the alert up to a case that's already in-progress/closed
  const desired = ALERT_STATUS_FOR_CASE[existingCase.status] || 'open';
  if (desired !== 'open') {
    try {
      await client.setAlertsWorkflowStatus(alert.spaceId, [alert.id], desired);
    } catch (err) {
      // Deliberately non-fatal: the alert IS on the case, it just didn't inherit
      // the status. Worth a warning, not worth failing the analyst's command
      log.warn('alert status sync failed - alert is attached but status not inherited', {
        err,
        caseId,
        alertId: alert.id,
        desired,
      });
    }
  }

  return {
    caseId,
    alertId: alert.id,
    ruleName: alert.ruleName,
    link: caseUrl(alert.spaceId, caseId, alert.owner),
  };
}

module.exports = {
  createCaseForAlert,
  createCaseForGroup,
  addAlertToCase,
};