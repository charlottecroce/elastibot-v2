'use strict';

const https = require('https');
const axios = require('axios');
const config = require('../config');
const { installRetry } = require('./util/retry');
const { TtlCache } = require('./util/cache');
const { DEFAULT_SPACE, UNKNOWN_RULE } = require('./constants');

/*
 * Thin client over Elasticsearch (alert lookups) and Kibana (Cases/Spaces APIs)
 *
 * A single Elastic API key authenticates to BOTH ES and Kibana, so we build one client per API key:
 *   - createElasticClient(apiKey)  > per-analyst (attributes cases to that user), cached
 *   - getServiceClient()           > shared, uses the service key for watchers
 *   - provisionAnalystApiKey(...)  > one-shot, uses an admin-supplied key that is NEVER cached
 */

/*
 * The ingest timestamp. Every query in this file ranges and sorts on it:
 * getAlertsSince pages on it, getRelatedAlerts bounds the burst window on it,
 * and getAlertStats buckets on it. toAlert exposes it as `cursorTimestamp`.
 *
 * NOTE this is NOT the same field as alert.timestamp, which prefers
 * kibana.alert.@timestamp (the detection time) and falls back to this one.
 * Changing CURSOR_FIELD changes all three queries and watchers/alerts.js
 */
const CURSOR_FIELD = '@timestamp';

const agent = new https.Agent({
  rejectUnauthorized: config.elastic.tlsRejectUnauthorized,
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: config.elastic.maxSockets,
  maxFreeSockets: 10,
  timeout: config.elastic.requestTimeoutMs,
});

/** Read an alert field that may be stored either dotted ("a.b.c") or nested */
function field(source, dotted) {
  if (source == null) return undefined;
  if (source[dotted] !== undefined) return source[dotted];
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), source);
}

/** Kibana solution "owner" derived from an alert's rule consumer */
function ownerFromConsumer(consumer) {
  if (!consumer) return config.elastic.defaultOwner;
  if (consumer === 'siem') return 'securitySolution';
  const observability = [
    'logs', 'metrics', 'apm', 'uptime', 'slo',
    'observability', 'infrastructure', 'alerts',
  ];
  if (observability.includes(consumer)) return 'observability';
  return 'cases';
}

/**
 * Map an ES hit to the trimmed alert shape the rest of the app works with.
 *
 * `timestamp` is for display and grouping; `cursorTimestamp` is for paging.
 * They come from different fields and are not interchangeable
 */
function toAlert(hit) {
  const src = hit._source || {};
  const spaceIds = field(src, 'kibana.space_ids');
  return {
    id: hit._id,
    index: hit._index,
    spaceId: (Array.isArray(spaceIds) ? spaceIds[0] : spaceIds) || DEFAULT_SPACE,
    ruleName: field(src, 'kibana.alert.rule.name') || UNKNOWN_RULE,
    ruleId: field(src, 'kibana.alert.rule.uuid'),
    severity: field(src, 'kibana.alert.severity') || 'unknown',
    timestamp: field(src, 'kibana.alert.@timestamp') || field(src, CURSOR_FIELD),
    cursorTimestamp: field(src, CURSOR_FIELD),
    owner: ownerFromConsumer(field(src, 'kibana.alert.rule.consumer')),
    userName: field(src, 'user.name'),
    hostName: field(src, 'host.name'),
  };
}

/**
 * Build a client. Prefer createElasticClient(), which caches - this is exported
 * mainly so the service client (and the admin-provisioning path) can bypass
 * the cache. An admin credential pasted into /start's automatic option is
 * deliberately built this way: it must never end up sitting in clientCache
 */
function buildElasticClient(apiKey) {
  if (!apiKey) throw new Error('An Elastic API key is required to build a client.');

  const transport = {
    timeout: config.elastic.requestTimeoutMs,
    httpsAgent: agent,
    maxContentLength: config.elastic.maxResponseBytes,
    maxBodyLength: config.elastic.maxResponseBytes,
  };

  const es = axios.create({
    ...transport,
    baseURL: config.elastic.esUrl,
    headers: { Authorization: `ApiKey ${apiKey}`, 'Content-Type': 'application/json' },
  });

  const kib = axios.create({
    ...transport,
    baseURL: config.elastic.kibanaUrl,
    headers: {
      Authorization: `ApiKey ${apiKey}`,
      'Content-Type': 'application/json',
      'kbn-xsrf': 'elastibot', // required by Kibana for state-changing requests
    },
  });

  // Retries reads only - see util/retry.js
  const retryOpts = {
    retries: config.elastic.retries,
    baseDelayMs: config.elastic.retryBaseDelayMs,
  };
  installRetry(es, { ...retryOpts, name: 'es' });
  installRetry(kib, { ...retryOpts, name: 'kibana' });

  // Space paths: the default space is un-prefixed; others use /s/<id>
  const spacePath = (spaceId) =>
    spaceId && spaceId !== DEFAULT_SPACE ? `/s/${encodeURIComponent(spaceId)}` : '';

  const alertsPath = `/${encodeURIComponent(config.elastic.alertsIndex)}/_search`;

  return {
    /** Resolve a single alert document by its _id */
    async getAlertById(alertId) {
      const { data } = await es.post(alertsPath, {
        size: 1,
        query: { ids: { values: [alertId] } },
      });
      const hit = data?.hits?.hits?.[0];
      if (!hit) return null;
      return toAlert(hit);
    },

    /** Alerts with CURSOR_FIELD strictly after `sinceIso`, oldest first */
    async getAlertsSince(sinceIso, size = 25) {
      const range = sinceIso
        ? { range: { [CURSOR_FIELD]: { gt: sinceIso } } }
        : { match_all: {} };
      const { data } = await es.post(alertsPath, {
        size,
        sort: [{ [CURSOR_FIELD]: 'asc' }],
        query: range,
      });
      return (data?.hits?.hits || []).map((hit) => toAlert(hit));
    },

    /**
     * All alerts for a user + host in a space within [from, to] (inclusive)
     * Used to combine a burst of related alerts into a single case
     *
     * `from` and `to` MUST be ingest timestamps (alert.cursorTimestamp), because
     * that is the field ranged on below. Passing detection times
     * (alert.timestamp, which prefers kibana.alert.@timestamp) returns the wrong
     * set whenever the two clocks drift, and does it silently - the case is
     * created, it just holds the wrong alerts. grouping.js supplies these as
     * group.queryFrom / group.queryTo, kept separate from the from/to shown in
     * the Slack message
     */
    async getRelatedAlerts({ spaceId, userName, hostName, from, to, size = 200 }) {
      const must = [
        { term: { 'user.name': userName } },
        { term: { 'host.name': hostName } },
        { range: { [CURSOR_FIELD]: { gte: from, lte: to } } },
      ];
      if (spaceId) must.push({ term: { 'kibana.space_ids': spaceId } });
      const { data } = await es.post(alertsPath, {
        size,
        sort: [{ [CURSOR_FIELD]: 'asc' }],
        query: { bool: { must } },
      });
      return (data?.hits?.hits || []).map((hit) => toAlert(hit));
    },

    /**
     * Everything /stats renders, in ONE size:0 aggregation search - no alert
     * documents come back, so a 30 day window costs about what an hour does
     *
     * Field names assume the stock .alerts-security schema, where the ECS fields
     * are keyword-mapped. If ALERTS_INDEX points somewhere custom and a terms agg
     * complains about fielddata, the field is `text` there and needs a `.keyword`
     * suffix (see config.stats.processField for the one that varies most)
     */
    async getAlertStats({
      from,
      to,
      spaceId,
      ruleName,
      hostName,
      userName,
      topN = 10,
      timeZone = 'UTC',
    }) {
      const filter = [{ range: { [CURSOR_FIELD]: { gte: from, lte: to } } }];
      if (spaceId) filter.push({ term: { 'kibana.space_ids': spaceId } });
      if (ruleName) filter.push({ term: { 'kibana.alert.rule.name': ruleName } });
      if (hostName) filter.push({ term: { 'host.name': hostName } });
      if (userName) filter.push({ term: { 'user.name': userName } });

      const { data } = await es.post(alertsPath, {
        size: 0,
        track_total_hits: true,
        query: { bool: { filter } },
        aggs: {
          // Pull more rules than we display: the "noisiest" list re-ranks this same bucket set client-side
          rules: {
            terms: { field: 'kibana.alert.rule.name', size: Math.max(topN * 3, 30) },
            aggs: {
              hosts: { cardinality: { field: 'host.name' } },
              users: { cardinality: { field: 'user.name' } },
              risk: { avg: { field: 'kibana.alert.risk_score' } },
              last_seen: { max: { field: CURSOR_FIELD } },
              // Alerts attached to a case carry kibana.alert.case_ids
              in_cases: { filter: { exists: { field: 'kibana.alert.case_ids' } } },
            },
          },
          severities: { terms: { field: 'kibana.alert.severity', size: 5 } },
          workflow: { terms: { field: 'kibana.alert.workflow_status', size: 5 } },
          hosts: { terms: { field: 'host.name', size: topN } },
          users: { terms: { field: 'user.name', size: topN } },
          processes: { terms: { field: config.stats.processField, size: topN } },
          spaces: { terms: { field: 'kibana.space_ids', size: topN } },
          rule_count: { cardinality: { field: 'kibana.alert.rule.name' } },
          host_count: { cardinality: { field: 'host.name' } },
          user_count: { cardinality: { field: 'user.name' } },
          risk: { stats: { field: 'kibana.alert.risk_score' } },
          in_cases: { filter: { exists: { field: 'kibana.alert.case_ids' } } },
          // Hour-of-day and day-of-week are folded out of these buckets client-side, which keeps the query free of runtime scripts
          over_time: {
            date_histogram: {
              field: CURSOR_FIELD,
              calendar_interval: 'hour',
              time_zone: timeZone,
              format: "yyyy-MM-dd'T'HH",
              min_doc_count: 0,
            },
          },
        },
      });
      return data;
    },

    /**
     * Kibana space display name.
     *
     * Errors propagate on purpose. services/spaceService owns the fallback, so
     * that a real outage produces one warn line there instead of being silently
     * turned into a plausible-looking space id in two places
     */
    async getSpaceName(spaceId) {
      const { data } = await kib.get(`/api/spaces/space/${encodeURIComponent(spaceId)}`);
      return data?.name || spaceId;
    },

    /** Create a case in the given space. Returns the raw case object */
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

    /**
     * Create a new Elastic API key, authenticated as whoever `apiKey` (above,
     * in the enclosing buildElasticClient call) belongs to. Only the
     * admin-provisioning path in /start calls this - an analyst's own client
     * never does
     *
     * POST /_security/api_key is an Elasticsearch security API, not Kibana, so
     * it goes through `es`, not `kib`. It requires the caller to hold
     * manage_api_key or manage_own_api_key; Elasticsearch itself rejects the
     * call otherwise (401/403), which is what actually enforces "not just
     * anyone can do this" - the role_descriptors passed in scope what the NEW
     * key can do, independent of what the caller is allowed to do
     *
     * @param {object} opts
     * @param {string} opts.name             e.g. elastibot-jsmith
     * @param {object} opts.roleDescriptors  the ONLY privileges the new key gets
     * @returns {Promise<{id:string,name:string,api_key:string,encoded:string}>}
     */
    async createApiKey({ name, roleDescriptors }) {
      const { data } = await es.post('/_security/api_key', {
        name,
        role_descriptors: roleDescriptors,
      });
      return data;
    },
  };
}

/*
 * Clients are cached per API key. The TTL bounds how long a revoked key keeps a
 * working client; the cap bounds memory. commands/start.js also invalidates
 * explicitly when an analyst re-registers, so a rotation takes effect at once
 *
 * The cache key is a secret. It stays in memory and is never logged - TtlCache
 * exposes `size`, never its keys
 */
const clientCache = new TtlCache({
  ttlMs: config.cache.clientTtlMs,
  max: config.cache.maxClients,
});

function createElasticClient(apiKey) {
  if (!apiKey) throw new Error('An Elastic API key is required to build a client.');
  return clientCache.getOrCreate(apiKey, buildElasticClient);
}

/** Drop a cached client. Called when an analyst re-registers with a new key */
function invalidateClient(apiKey) {
  return clientCache.delete(apiKey);
}

/**
 * Provision a brand new, narrowly-scoped Elastic API key for an analyst, using
 * an admin-supplied credential that has permission to create API keys.
 *
 * This backs /start's "create one for me" option: a UAC-style prompt where an
 * analyst borrows an admin's credential for exactly one request instead of
 * copy-pasting a key out of Kibana themselves. Deliberately built with
 * buildElasticClient rather than createElasticClient, so the admin credential
 * never enters clientCache - it lives only for the duration of this call and
 * is discarded (never stored, cached, or logged) as soon as it returns
 *
 * @param {string} adminApiKey  base64 Elastic API key with manage_api_key (or
 *   manage_own_api_key) - if it lacks that privilege, Elasticsearch rejects
 *   the request and this rejects too; nothing here grants any privilege itself
 * @param {string} name         name for the new key, e.g. elastibot-jsmith
 * @returns {Promise<{id:string,name:string,apiKey:string}>} apiKey is the
 *   base64 "encoded" form, ready to hand straight to UserStore.set - the same
 *   shape an analyst would otherwise paste in by hand
 */
async function provisionAnalystApiKey(adminApiKey, name) {
  const admin = buildElasticClient(adminApiKey);
  const created = await admin.createApiKey({
    name,
    roleDescriptors: config.elastic.analystRoleDescriptors,
  });
  return { id: created.id, name: created.name, apiKey: created.encoded };
}

// Lazy service client for non-user operations (watchers, space lookups)
let _serviceClient;

function getServiceClient() {
  if (_serviceClient !== undefined) return _serviceClient;
  _serviceClient = config.elastic.serviceApiKey
    ? buildElasticClient(config.elastic.serviceApiKey)
    : null;
  return _serviceClient;
}

/** Drop the cached service client, e.g. after a key rotation */
function resetServiceClient() {
  _serviceClient = undefined;
}

module.exports = {
  createElasticClient,
  buildElasticClient,
  invalidateClient,
  provisionAnalystApiKey,
  getServiceClient,
  resetServiceClient,
  ownerFromConsumer,
  toAlert,
  field,
  CURSOR_FIELD,
};