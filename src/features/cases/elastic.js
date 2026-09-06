'use strict';

const config = require('../../../config');
const { extend, CURSOR_FIELD, toAlert } = require('../../core/elastic');

/*
 * The Elasticsearch and Kibana endpoints the cases feature uses.
 *
 * THIS FILE REPLACES a copy of the whole pre-refactor src/elastic.js that landed
 * here during the move. That copy built its own https.Agent, its own axios pair
 * and its own TtlCache, so the process had two client caches and two connection
 * pools with the same API keys in them - and sigma's detection-rule endpoints
 * were reachable from the cases feature, which is exactly the cross-feature
 * coupling the split exists to prevent. All of that now lives once, in
 * src/core/elastic/.
 *
 * Every method body below is the one that was in src/elastic.js, with the axios
 * call replaced by the core primitive. Nothing else changed: request() returns
 * the response body, which is what each of these already destructured out.
 *
 * getAlertsSince stays in this feature rather than going to core. It has one
 * consumer - watchers/alerts.js - and the promotion rule is second consumer or
 * it stays. What core does own is the SCHEMA underneath it (CURSOR_FIELD,
 * toAlert, searchAlerts), because cases reads alerts and stats aggregates over
 * them and that genuinely is two. A future rule-analysis feature gets
 * searchAlerts and toAlert from core and writes its own query.
 */

/**
 * @param {object} client a core client from getClient()/getServiceClient()
 * @returns {object} the same client, plus the cases endpoints
 */
function casesEndpoints(client) {
  return extend(client, {
    /** Resolve a single alert document by its _id */
    async getAlertById(alertId) {
      const data = await client.searchAlerts({
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
      const data = await client.searchAlerts({
        size,
        sort: [{ [CURSOR_FIELD]: 'asc' }],
        query: range,
      });
      return (data?.hits?.hits || []).map((hit) => toAlert(hit));
    },

    /** Create a case in the given space. Returns the raw case object */
    createCase(spaceId, body) {
      return client.request(spaceId, 'POST', '/api/cases', body);
    },

    /** Fetch one case - we want its `status` before attaching an alert */
    getCase(spaceId, caseId) {
      return client.request(spaceId, 'GET', `/api/cases/${encodeURIComponent(caseId)}`);
    },

    /**
     * Force the workflow status on alerts.
     *
     * Case syncing only pushes status to alerts when the CASE status changes, so
     * an alert joining an already in-progress/closed case needs this once. After
     * that the case's own syncing keeps it in line
     */
    setAlertsWorkflowStatus(spaceId, alertIds, status) {
      if (!alertIds || !alertIds.length) return Promise.resolve(null);
      return client.request(spaceId, 'POST', '/api/detection_engine/signals/status', {
        signal_ids: alertIds,
        status,
      });
    },

    /** Attach an alert to an existing case */
    attachAlert(spaceId, caseId, attachment) {
      return client.request(
        spaceId,
        'POST',
        `/api/cases/${encodeURIComponent(caseId)}/comments`,
        attachment
      );
    },

    /** Recent cases in a space, newest first */
    async findRecentCases(spaceId, perPage = config.watchers.cases.perPage) {
      const data = await client.request(spaceId, 'GET', '/api/cases/_find', undefined, {
        params: { sortField: 'createdAt', sortOrder: 'desc', perPage },
      });
      return data?.cases || [];
    },
  });
}

module.exports = { casesEndpoints };