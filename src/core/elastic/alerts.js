'use strict';

const config = require('../../../config');
const { DEFAULT_SPACE, UNKNOWN_RULE } = require('../constants');

/*
 * The alert document: where it lives, which timestamp means what, and how a raw
 * ES hit becomes the trimmed object the rest of the app works with.
 *
 * This is in core rather than in features/cases, and the rule that put it here
 * is the same one that keeps everything else out: it already has two consumers.
 * Cases reads alerts one at a time and in cursor order; stats aggregates over
 * the same index and ranges and buckets on the same CURSOR_FIELD. Two features,
 * one schema.
 *
 * What is NOT here is any particular QUERY. `getAlertsSince` is one query with
 * one consumer and it lives in features/cases; `getAlertStats` is one query with
 * one consumer and it lives in features/stats. A future rule-analysis feature
 * that wants alert data gets searchAlerts() and toAlert() from here and writes
 * its own query - it does not reach into features/cases, and if it turns out to
 * want that exact query, that is the second consumer and the query gets promoted
 * then rather than now.
 */

/*
 * The ingest timestamp. Every query that pages or buckets over time ranges and
 * sorts on it; toAlert exposes it as `cursorTimestamp`.
 *
 * NOTE this is NOT the same field as alert.timestamp, which prefers
 * kibana.alert.@timestamp (the detection time) and falls back to this one.
 * Changing CURSOR_FIELD changes the cases watcher's cursor and the stats
 * histogram at the same time, which is most of why it is defined once, here.
 */
const CURSOR_FIELD = '@timestamp';

/** The _search path for the configured alerts index pattern */
const alertsPath = `/${encodeURIComponent(config.elastic.alertsIndex)}/_search`;

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

module.exports = { CURSOR_FIELD, alertsPath, field, ownerFromConsumer, toAlert };