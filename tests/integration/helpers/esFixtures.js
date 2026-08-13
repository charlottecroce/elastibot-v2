'use strict';

/*
 * Index management for the integration suite.
 *
 * `dynamic: strict` in the mapping is a deliberate choice. It means a typo in a
 * fixture field name is rejected at index time instead of quietly creating a
 * field nothing queries, which would leave a test passing against data that
 * doesn't look like a real alert.
 *
 * The mapping itself is the point of these tests as much as the queries are:
 * process.name being `keyword` rather than `text` is the sort of thing
 * that only breaks against a real cluster.
 */

const axios = require('axios');
const path = require('path');
const { stack, indices, fixtures } = require('../../testenv');

const MAPPING = require('../fixtures/alerts-mapping.json');

function adminClient() {
  return axios.create({
    baseURL: stack.esUrl,
    auth: { username: stack.username, password: stack.password },
    timeout: 20000,
  });
}

const es = adminClient();

/** Drop and recreate the write index. Each test file starts from nothing */
async function resetAlertsIndex(index = indices.writeIndex) {
  await es.delete(`/${index}`, {
    params: { ignore_unavailable: true },
    validateStatus: (s) => s < 400 || s === 404,
  });
  await es.put(`/${index}`, MAPPING);
  return index;
}

/** Delete every index under the test pattern */
async function deleteAllTestIndices() {
  await es.delete(`/${encodeURIComponent(indices.testPattern)}`, {
    params: { ignore_unavailable: true, allow_no_indices: true },
    validateStatus: (s) => s < 400 || s === 404,
  });
}

let seq = 0;

/**
 * One alert document, in the shape src/elastic.js#toAlert expects.
 *
 * Every field except the timestamps defaults from testenv.fixtures.alert, so a
 * test states only what it is actually asserting on. The overrides are merged
 * before the destructure rather than being parameter defaults, which is what
 * lets the defaults live somewhere other than this signature.
 *
 * Both timestamps default to the same instant but stay separate, because they
 * are separate fields with separate jobs: `timestamp` is detection time (what
 * grouping and display use) and `ingested` is @timestamp, the field the watcher
 * cursor ranges and sorts on. Tests that don't care can ignore both; the ones
 * about paging very much care.
 *
 * @param {object} [overrides] any of fixtures.alert, plus id/timestamp/ingested
 */
function makeAlert(overrides = {}) {
  const merged = { ...fixtures.alert, ...overrides };

  const {
    id,
    timestamp = new Date().toISOString(),
    spaceId,
    rule,
    ruleUuid,
    consumer,
    severity,
    riskScore,
    host,
    user,
    // `process` would shadow the global inside this function
    process: processName,
    action,
  } = merged;

  const ingested = merged.ingested ?? timestamp;

  seq += 1;
  const uuid = id || `alert-${seq}`;

  return {
    _id: uuid,
    doc: {
      '@timestamp': ingested,
      'kibana.alert.@timestamp': timestamp,
      'kibana.space_ids': [spaceId],
      'kibana.alert.uuid': uuid,
      'kibana.alert.rule.name': rule,
      'kibana.alert.rule.uuid': ruleUuid,
      'kibana.alert.rule.consumer': consumer,
      'kibana.alert.rule.rule_type_id': 'siem.queryRule',
      'kibana.alert.severity': severity,
      'kibana.alert.risk_score': riskScore,
      'kibana.alert.workflow_status': 'open',
      'host.name': host,
      'user.name': user,
      'process.name': processName,
      'event.action': action,
      'event.category': 'process',
    },
  };
}

/**
 * Bulk-index alerts and wait until they're searchable.
 *
 * The explicit refresh matters. Without it every test would need its own
 * retry loop against the near-real-time gap, and the first flaky CI run would
 * be blamed on the query rather than on the missing refresh.
 */
async function indexAlerts(alerts, index = indices.writeIndex) {
  const body =
    alerts
      .map(
        ({ _id, doc }) =>
          `${JSON.stringify({ index: { _index: index, _id } })}\n${JSON.stringify(doc)}`
      )
      .join('\n') + '\n';

  const { data } = await es.post('/_bulk', body, {
    params: { refresh: 'wait_for' },
    headers: { 'Content-Type': 'application/x-ndjson' },
  });

  if (data.errors) {
    const first = data.items.find((i) => i.index?.error)?.index?.error;
    throw new Error(`bulk index failed: ${JSON.stringify(first)}`);
  }
  return alerts.map((a) => a._id);
}

/** Minutes before now, as an ISO string. Reads better than Date arithmetic inline */
function minutesAgo(n) {
  return new Date(Date.now() - n * 60000).toISOString();
}

module.exports = {
  adminClient,
  resetAlertsIndex,
  deleteAllTestIndices,
  makeAlert,
  indexAlerts,
  minutesAgo,
  MAPPING_PATH: path.join(__dirname, '..', 'fixtures', 'alerts-mapping.json'),
};