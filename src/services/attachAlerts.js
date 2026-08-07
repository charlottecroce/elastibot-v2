'use strict';

const config = require('../../config');
const { describeAxiosError } = require('../util/errors');

/*
 * Attaching alerts to a case, in one place.
 *
 * Kibana's comments API takes one rule per alert-comment but accepts an array
 * of alert ids, so alerts are batched by rule and posted one batch per rule.
 * That loop - group, post, collect the failures, format them into a sentence an
 * analyst can read - used to exist three times in caseService.js (inside
 * createCaseFromAlerts, inside attachAlertsToCase, and in a one-alert variant
 * inside addAlertToCase). The three copies had already drifted: two of them
 * resolved `owner` per batch, one used a single case-wide owner, and only one
 * of them counted `attached` separately from `attachedIds.length`.
 *
 * One copy, one behaviour, one place to test.
 */

/** Rule identity for batching. ruleId is authoritative; name is the fallback */
function ruleKey(alert) {
  return alert.ruleId || alert.ruleName || 'unknown';
}

/**
 * Group alerts by rule, preserving first-seen order.
 * @param {object[]} alerts
 * @returns {Map<string, object[]>}
 */
function groupByRule(alerts) {
  const byRule = new Map();
  for (const alert of alerts) {
    const key = ruleKey(alert);
    const list = byRule.get(key);
    if (list) list.push(alert);
    else byRule.set(key, [alert]);
  }
  return byRule;
}

/**
 * Post every alert onto `caseId`, one request per rule.
 *
 * Never throws for a partial failure: a case that got 9 of 10 alerts is still
 * a useful case, and the caller decides whether "none of them landed" is fatal
 * (creating a case) or merely worth reporting (adding to an existing one).
 *
 * @param {object} client   Elastic client with attachAlert(spaceId, caseId, attachment)
 * @param {object} opts
 * @param {string} opts.spaceId
 * @param {string} opts.caseId
 * @param {object[]} opts.alerts
 * @param {string} [opts.owner] force one owner for every batch (case creation
 *   picks a single owner for the whole case). Omit to take each batch's own
 *   owner, falling back to the configured default
 * @returns {Promise<{attachedIds: string[], failures: string[], warning: string|null}>}
 */
async function attachInRuleBatches(client, { spaceId, caseId, alerts, owner }) {
  const attachedIds = [];
  const failures = [];

  for (const batch of groupByRule(alerts).values()) {
    const [first] = batch;
    try {
      await client.attachAlert(spaceId, caseId, {
        type: 'alert',
        alertId: batch.map((a) => a.id),
        index: batch.map((a) => a.index),
        rule: { id: first.ruleId, name: first.ruleName },
        owner: owner || first.owner || config.elastic.defaultOwner,
      });
      attachedIds.push(...batch.map((a) => a.id));
    } catch (err) {
      failures.push(
        `${first.ruleName} \u00d7${batch.length} (${describeAxiosError(err, 'attach').message})`
      );
    }
  }

  return {
    attachedIds,
    failures,
    warning: failures.length ? `Some alerts didn't attach: ${failures.join('; ')}` : null,
  };
}

module.exports = { attachInRuleBatches, groupByRule, ruleKey };