'use strict';

const config = require('../../../config');
const { extend, CURSOR_FIELD } = require('../../core/elastic');

/*
 * The one Elasticsearch endpoint /stats uses.
 *
 * The body is the one that was in src/elastic.js, with the axios call replaced
 * by client.searchAlerts() - which is core's primitive over the same configured
 * alerts index, and the reason the index pattern did not have to be duplicated
 * into this feature.
 *
 * Field names assume the stock .alerts-security schema, where the ECS fields are
 * keyword-mapped. If ALERTS_INDEX points somewhere custom and a terms agg
 * complains about fielddata, the field is `text` there and needs a `.keyword`
 * suffix - see config.stats.processField for the one that varies most, which is
 * why that one is a setting and the rest are not.
 */

function statsEndpoints(client) {
  return extend(client, {
    /**
     * Everything /stats renders, in ONE size:0 aggregation search - no alert
     * documents come back, so a 30 day window costs about what an hour does
     */
    getAlertStats({
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

      return client.searchAlerts({
        size: 0,
        track_total_hits: true,
        query: { bool: { filter } },
        aggs: {
          // Pull more rules than we display: the "noisiest" list re-ranks this
          // same bucket set client-side
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
          // Hour-of-day and day-of-week are folded out of these buckets
          // client-side, which keeps the query free of runtime scripts
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
    },
  });
}

module.exports = { statsEndpoints };