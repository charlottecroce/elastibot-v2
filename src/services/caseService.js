'use strict';

const config = require('../../config');
const { createElasticClient } = require('../elastic');
const { buildCaseTitle, monthYearTag } = require('../naming');
const { caseUrl } = require('./kibanaLinks');
const { getSpaceName } = require('./spaceService');
const { attachInRuleBatches } = require('./attachAlerts');
const { ALERT_STATUS_FOR_CASE, DEFAULT_SPACE, UNKNOWN_RULE } = require('../constants');
const { UserFacingError, describeAxiosError } = require('../util/errors');
const { logger } = require('../util/logger');

/*
 * Case creation and alert attachment. Error types come from util/errors
 *
 * The per-rule attach loop (group alerts by rule, POST one comment per rule,
 * collect failures into a readable warning) lives in services/attachAlerts.js
 * now, not here. It used to be copy-pasted between createCaseFromAlerts and
 * attachAlertsToCase and the two copies had already drifted - see that file's
 * header for the details
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

/** An error status that means "this one id isn't there"*/
const MISSING_STATUSES = new Set([400, 404]);

/**
 * Resolve alert ids to alerts, tolerating individual misses but not a systemic failure.
 *
 * @param {object} client
 * @param {string[]} alertIds
 * @returns {Promise<object[]>} deduped alerts, in the order the ids came in
 */
async function fetchAlertsByIds(client, alertIds) {
  const settled = await Promise.all(
    alertIds.map((id) =>
      client
        .getAlertById(id)
        .then((alert) => ({ alert }))
        .catch((err) => ({ err }))
    )
  );

  const fatal = settled.find(
    ({ err }) => err && !MISSING_STATUSES.has(err.response?.status)
  );
  if (fatal) throw describeAxiosError(fatal.err, 'Looking up alerts');

  return dedupeById(settled.map(({ alert }) => alert).filter(Boolean));
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
  const spaceName = await getSpaceName(spaceId, client);

  const ruleCounts = {};
  const ownerCounts = {};
  for (const a of alerts) {
    const rn = a.ruleName || UNKNOWN_RULE;
    ruleCounts[rn] = (ruleCounts[rn] || 0) + 1;
    const ow = a.owner || config.elastic.defaultOwner;
    ownerCounts[ow] = (ownerCounts[ow] || 0) + 1;
  }
  const representativeRule = topKey(ruleCounts) || UNKNOWN_RULE;
  const owner = topKey(ownerCounts) || config.elastic.defaultOwner;
  const repUser = alerts.find((a) => a.userName)?.userName;
  const repHost = alerts.find((a) => a.hostName)?.hostName;

  // timeZone pins the title's date so the same alert yields the same case name
  // regardless of the host's local timezone
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

  // Attach alerts in per-rule batches. `owner` is forced across every batch -
  // case creation picks one owner for the whole case, unlike attaching to an
  // existing case where each alert keeps its own
  const { attachedIds, warning } = await attachInRuleBatches(client, {
    spaceId,
    caseId,
    alerts,
    owner,
  });

  if (attachedIds.length === 0) {
    const reason = warning ? warning.replace(/^Some alerts didn't attach: /, '') : 'unknown error';
    throw new UserFacingError(
      `Case *${title}* (\`${caseId}\`) was created, but attaching alerts failed: ${reason}`
    );
  }

  // Partial failures are reported to the analyst in the Slack message, and
  // logged here so there's a record after that message scrolls away
  if (warning) {
    log.warn('some alerts did not attach', {
      caseId,
      spaceId,
      attached: attachedIds.length,
      failed: alerts.length - attachedIds.length,
    });
  }

  return {
    caseId,
    title,
    spaceId,
    spaceName,
    // `owner` is what incidents.recordCase stores as rec.caseOwner, so a
    // "View case" link can be rebuilt from the record alone later
    owner,
    ruleName: representativeRule,
    ruleCounts,
    alertCount: alerts.length,
    attachedCount: attachedIds.length,
    attachedIds,
    warning,
    link: caseUrl(spaceId, caseId, owner),
  };
}

/**
 * /case <alertID> and the singleton "Create case" button
 * Files just the given alert into a case - no sibling gathering. The grouped
 * "Create case" button uses createCaseForIds to combine a whole incident
 *
 * @param {string} apiKey    the analyst's Elastic API key
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
 * Create one case from an explicit list of alert ids already known to the
 * caller - an open incident's rec.alertIds. Deliberately does NOT re-run a
 * user+host+time query: the incident record is already the authoritative list
 * of what the Slack message shows, and a fresh query could disagree with it (an
 * alert that aged out of the window, a stale cursor, etc). Backs the green
 * "Create case" button on a posted incident.
 *
 * @param {string} apiKey
 * @param {string[]} alertIds
 * @param {object} [opts]
 * @param {string} [opts.spaceId] expected space. Fetched alerts are filtered
 *   to it as a sanity check - an id that resolved to a different space than
 *   the incident it came from would otherwise silently end up in the wrong
 *   case
 * @returns {Promise<object>} same shape as createCaseFromAlerts, including attachedIds
 */
async function createCaseForIds(apiKey, alertIds, { spaceId } = {}) {
  const client = createElasticClient(apiKey);

  let alerts = await fetchAlertsByIds(client, alertIds);
  if (spaceId) alerts = alerts.filter((a) => a.spaceId === spaceId);

  if (!alerts.length) {
    throw new UserFacingError(
      'None of these alerts could be found — they may have aged out of the index.'
    );
  }

  return createCaseFromAlerts(client, alerts);
}

/**
 * Attach a batch of already-known alert ids to an EXISTING case, in the same
 * per-rule batches createCaseFromAlerts uses. Backs the "Add N new alerts to
 * case" button on a posted incident - the case already exists by this point,
 * so there is no title/owner logic here, only the attach step
 *
 * Unlike createCaseFromAlerts, no owner override is passed to
 * attachInRuleBatches: the case's owner was already fixed at creation time, so
 * each batch just takes its own alert's owner (falling back to the configured
 * default), same as before this was pulled into the shared helper
 *
 * @param {string} apiKey
 * @param {object} opts
 * @param {string} opts.spaceId
 * @param {string} opts.caseId
 * @param {string[]} opts.alertIds  the incident's pending ids
 * @returns {Promise<{caseId: string, attachedIds: string[], warning: string|null}>}
 */
async function attachAlertsToCase(apiKey, { spaceId, caseId, alertIds }) {
  const client = createElasticClient(apiKey);

  const alerts = await fetchAlertsByIds(client, alertIds);
  if (!alerts.length) {
    // Nothing to attach is not fatal - the caller (commands/case.js) still has
    // a valid case and should just report that nothing new landed
    return {
      caseId,
      attachedIds: [],
      warning:
        'None of the pending alerts could be found — they may have aged out of the index.',
    };
  }

  const { attachedIds, warning } = await attachInRuleBatches(client, { spaceId, caseId, alerts });

  if (warning) {
    log.warn('some alerts did not attach to an existing case', {
      caseId,
      spaceId,
      attached: attachedIds.length,
      failed: alerts.length - attachedIds.length,
    });
  }

  return { caseId, attachedIds, warning };
}

/**
 * Attach an alert to an existing case. The case and alert must live in the same space
 *
 * We read the case first for its status: Kibana only pushes status to alerts on a
 * case status *change*, so an alert joining an already in-progress/closed case
 * would otherwise stay open. We set it to match once, then syncing takes over
 *
 * This is a single-alert attach, not a batch, so it does NOT go through
 * attachInRuleBatches (which always posts alertId/index as arrays). Its
 * request body is the scalar shape Kibana's comments API also accepts for one
 * alert, and callers/tests depend on that exact shape
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
    if (e.status === 404) {
      throw new UserFacingError(
        `Could not find case \`${caseId}\` in space \`${alert.spaceId}\`. ` +
          "Double-check the case ID from Elastibot's creation message."
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
      // Non-fatal: the alert is on the case, it just didn't inherit the status
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
  createCaseForIds,
  attachAlertsToCase,
  addAlertToCase,
};