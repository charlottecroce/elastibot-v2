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
const env = require('../env');

const MAPPING = require('../fixtures/alerts-mapping.json');

function adminClient() {
  return axios.create({
    baseURL: env.esUrl,
    auth: { username: env.username, password: env.password },
    timeout: 20000,
  });
}

const es = adminClient();

/** Drop and recreate the write index. Each test file starts from nothing */
async function resetAlertsIndex(index = env.writeIndex) {
  await es.delete(`/${index}`, {
    params: { ignore_unavailable: true },
    validateStatus: (s) => s < 400 || s === 404,
  });
  await es.put(`/${index}`, MAPPING);
  return index;
}

/** Delete every index under the test pattern */
async function deleteAllTestIndices() {
  await es.delete(`/${encodeURIComponent(env.alertsIndex)}`, {
    params: { ignore_unavailable: true, allow_no_indices: true },
    validateStatus: (s) => s < 400 || s === 404,
  });
}

let seq = 0;

/**
 * One alert document, in the shape src/elastic.js#toAlert expects.
 *
 * Both timestamps default to the same instant but are separate arguments,
 * because they are separate fields with separate jobs: `timestamp` is detection
 * time (what grouping and display use) and `ingested` is @timestamp, the field
 * the watcher cursor ranges and sorts on. Tests that don't care can ignore
 * both; the ones about paging very much care.
 */
function makeAlert({
  id,
  timestamp = new Date().toISOString(),
  ingested = timestamp,
  spaceId = 'default',
  rule = 'Malware Detected',
  ruleUuid = 'rule-uuid-a',
  consumer = 'siem',
  severity = 'high',
  riskScore = 47,
  host = 'WEB-01',
  user = 'jsmith',
  process = 'powershell.exe',
  action = 'process_start',
} = {}) {
  seq += 1;
  return {
    _id: id || `alert-${seq}`,
    doc: {
      '@timestamp': ingested,
      'kibana.alert.@timestamp': timestamp,
      'kibana.space_ids': [spaceId],
      'kibana.alert.uuid': id || `alert-${seq}`,
      'kibana.alert.rule.name': rule,
      'kibana.alert.rule.uuid': ruleUuid,
      'kibana.alert.rule.consumer': consumer,
      'kibana.alert.rule.rule_type_id': 'siem.queryRule',
      'kibana.alert.severity': severity,
      'kibana.alert.risk_score': riskScore,
      'kibana.alert.workflow_status': 'open',
      'host.name': host,
      'user.name': user,
      'process.name': process,
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
async function indexAlerts(alerts, index = env.writeIndex) {
  const body =
    alerts
      .map(({ _id, doc }) => `${JSON.stringify({ index: { _index: index, _id } })}\n${JSON.stringify(doc)}`)
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