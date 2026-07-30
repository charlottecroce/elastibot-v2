'use strict';

const https = require('https');
const axios = require('axios');
const config = require('../config');

/*
 * Thin client over Elasticsearch (alert lookups) and Kibana (Cases/Spaces APIs)
 *
 * A single Elastic API key authenticates to BOTH ES and Kibana, so we build one client per API key:
 *   - createElasticClient(apiKey)  > per-analyst (attributes cases to that user)
 *   - serviceClient                > shared, uses the service key for watchers
 */

const agent = new https.Agent({
  rejectUnauthorized: config.elastic.tlsRejectUnauthorized,
});

/** Read an alert field that may be stored either dotted ("a.b.c") or nested */
function field(source, dotted) {
  if (source == null) return undefined;
  if (source[dotted] !== undefined) return source[dotted];
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), source);
}

/** Kibana solution "owner" derived from an alert's rule consumer */
function ownerFromConsumer(consumer, fallback = config.elastic.defaultOwner) {
  if (!consumer) return fallback;
  if (consumer === 'siem') return 'securitySolution';
  const observability = [
    'logs', 'metrics', 'apm', 'uptime', 'slo',
    'observability', 'infrastructure', 'alerts',
  ];
  if (observability.includes(consumer)) return 'observability';
  return 'cases';
}

function createElasticClient(apiKey) {
  if (!apiKey) throw new Error('An Elastic API key is required to build a client.');

  const es = axios.create({
    baseURL: config.elastic.esUrl,
    timeout: config.elastic.requestTimeoutMs,
    httpsAgent: agent,
    headers: { Authorization: `ApiKey ${apiKey}`, 'Content-Type': 'application/json' },
  });

  const kib = axios.create({
    baseURL: config.elastic.kibanaUrl,
    timeout: config.elastic.requestTimeoutMs,
    httpsAgent: agent,
    headers: {
      Authorization: `ApiKey ${apiKey}`,
      'Content-Type': 'application/json',
      'kbn-xsrf': 'elastibot', // required by Kibana for state-changing requests
    },
  });

  // Space paths: the default space is un-prefixed; others use /s/<id>
  const spacePath = (spaceId) =>
    spaceId && spaceId !== 'default' ? `/s/${encodeURIComponent(spaceId)}` : '';

  return {
    field,

    /** Resolve a single alert document by its _id */
    async getAlertById(alertId) {
      const { data } = await es.post(
        `/${encodeURIComponent(config.elastic.alertsIndex)}/_search`,
        { size: 1, query: { ids: { values: [alertId] } } }
      );
      const hit = data?.hits?.hits?.[0];
      if (!hit) return null;
      const src = hit._source || {};
      const spaceIds = field(src, 'kibana.space_ids');
      return {
        id: hit._id,
        index: hit._index,
        source: src,
        spaceId: (Array.isArray(spaceIds) ? spaceIds[0] : spaceIds) || 'default',
        ruleName: field(src, 'kibana.alert.rule.name') || 'Unknown Rule',
        ruleId: field(src, 'kibana.alert.rule.uuid'),
        severity: field(src, 'kibana.alert.severity'),
        timestamp: field(src, 'kibana.alert.@timestamp') || field(src, '@timestamp'),
        owner: ownerFromConsumer(field(src, 'kibana.alert.rule.consumer')),
        userName: field(src, 'user.name'),
        hostName: field(src, 'host.name'),
      };
    },

    /** Alerts with @timestamp strictly after `sinceIso` */
    async getAlertsSince(sinceIso, size = 25) {
      const range = sinceIso
        ? { range: { '@timestamp': { gt: sinceIso } } }
        : { match_all: {} };
      const { data } = await es.post(
        `/${encodeURIComponent(config.elastic.alertsIndex)}/_search`,
        { size, sort: [{ '@timestamp': 'asc' }], query: range }
      );
      return (data?.hits?.hits || []).map((hit) => {
        const src = hit._source || {};
        const spaceIds = field(src, 'kibana.space_ids');
        return {
          id: hit._id,
          index: hit._index,
          spaceId: (Array.isArray(spaceIds) ? spaceIds[0] : spaceIds) || 'default',
          ruleName: field(src, 'kibana.alert.rule.name') || 'Unknown Rule',
          ruleId: field(src, 'kibana.alert.rule.uuid'),
          severity: field(src, 'kibana.alert.severity') || 'unknown',
          timestamp: field(src, 'kibana.alert.@timestamp') || field(src, '@timestamp'),
          owner: ownerFromConsumer(field(src, 'kibana.alert.rule.consumer')),
          userName: field(src, 'user.name'),
          hostName: field(src, 'host.name'),
        };
      });
    },

    /**
     * All alerts for a user + host in a space within [from, to] (inclusive)
     * Used to combine a burst of related alerts into a single case
     */
    async getRelatedAlerts({ spaceId, userName, hostName, from, to, size = 200 }) {
      const must = [
        { term: { 'user.name': userName } },
        { term: { 'host.name': hostName } },
        { range: { '@timestamp': { gte: from, lte: to } } },
      ];
      if (spaceId) must.push({ term: { 'kibana.space_ids': spaceId } });
      const { data } = await es.post(
        `/${encodeURIComponent(config.elastic.alertsIndex)}/_search`,
        { size, sort: [{ '@timestamp': 'asc' }], query: { bool: { must } } }
      );
      return (data?.hits?.hits || []).map((hit) => {
        const src = hit._source || {};
        const spaceIds = field(src, 'kibana.space_ids');
        return {
          id: hit._id,
          index: hit._index,
          spaceId: (Array.isArray(spaceIds) ? spaceIds[0] : spaceIds) || spaceId || 'default',
          ruleName: field(src, 'kibana.alert.rule.name') || 'Unknown Rule',
          ruleId: field(src, 'kibana.alert.rule.uuid'),
          severity: field(src, 'kibana.alert.severity') || 'unknown',
          timestamp: field(src, 'kibana.alert.@timestamp') || field(src, '@timestamp'),
          owner: ownerFromConsumer(field(src, 'kibana.alert.rule.consumer')),
          userName: field(src, 'user.name'),
          hostName: field(src, 'host.name'),
        };
      });
    },

    /** Kibana space display name (falls back to the id) */
    async getSpaceName(spaceId) {
      try {
        const { data } = await kib.get(`/api/spaces/space/${encodeURIComponent(spaceId)}`);
        return data?.name || spaceId;
      } catch {
        return spaceId;
      }
    },

    /** Create a case in the given space and eturns the raw case object */
    async createCase(spaceId, body) {
      const { data } = await kib.post(`${spacePath(spaceId)}/api/cases`, body);
      return data;
    },

    /** Fetch one case - we want its `status` before attaching an alert */
    async getCase(spaceId, caseId) {
      const { data } = await kib.get(
        `${spacePath(spaceId)}/api/cases/${encodeURIComponent(caseId)}`
      );
      return data;
    },

    /**
     * Force the workflow status on alerts
     *
     * Case syncing only pushes status to alerts when the CASE status changes, so
     * an alert joining an already in-progress/closed case needs this once. After
     * that the case's own syncing keeps it in line
     */
    async setAlertsWorkflowStatus(spaceId, alertIds, status) {
      if (!alertIds || !alertIds.length) return null;
      const { data } = await kib.post(
        `${spacePath(spaceId)}/api/detection_engine/signals/status`,
        { signal_ids: alertIds, status }
      );
      return data;
    },

    /** Attach an alert to an existing case */
    async attachAlert(spaceId, caseId, attachment) {
      const { data } = await kib.post(
        `${spacePath(spaceId)}/api/cases/${encodeURIComponent(caseId)}/comments`,
        attachment
      );
      return data;
    },

    /** Recent cases in a space, newest first */
    async findRecentCases(spaceId, perPage = 25) {
      const { data } = await kib.get(`${spacePath(spaceId)}/api/cases/_find`, {
        params: { sortField: 'createdAt', sortOrder: 'desc', perPage },
      });
      return data?.cases || [];
    },
  };
}

// Shared client for non-user operations (watchers, space lookups)
const serviceClient = config.elastic.serviceApiKey
  ? createElasticClient(config.elastic.serviceApiKey)
  : null;

module.exports = { createElasticClient, serviceClient, ownerFromConsumer, field };