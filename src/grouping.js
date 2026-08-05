'use strict';

const { UNKNOWN_RULE, SEVERITY_RANK } = require('./constants');

/*
 * Alert grouping
 *
 * A burst of alerts from the same user on the same host (same space), close
 * together in time, is really one incident - even if the alerts fire different
 * rules. We collapse such bursts into one group so the channel shows one message
 * per incident, and so "Create case" attaches the whole burst to a single case
 *
 * Grouping key: spaceId + user.name + host.name
 * Time clustering: alerts join a cluster while within `windowMs` of the cluster's
 *   first alert. Alerts missing user.name or host.name can't be correlated, so
 *   each becomes its own singleton group
 *
 * TWO CLOCKS, AND THEY ARE NOT INTERCHANGEABLE
 *
 *   alert.timestamp        detection time (kibana.alert.@timestamp, falling back
 *                          to @timestamp). What a human means by "when did this
 *                          fire". Used for clustering and for display
 *   alert.cursorTimestamp  ingest time (@timestamp). What Elastic actually
 *                          ranges and sorts on in every query in src/elastic.js
 *
 * A group therefore carries both: `from`/`to` for the Slack message, and
 * `queryFrom`/`queryTo` for the button, which get handed straight back to
 * getRelatedAlerts. Bounding an @timestamp range with detection times silently
 * returns the wrong set of alerts whenever the two clocks drift - the case looks
 * fine and holds the wrong alerts. Keep the pairs matched
 */

/** Detection time - clustering and display */
function ts(a) {
  const t = Date.parse(a.timestamp);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Ingest time - the only thing safe to hand back to a query.
 * Falls back to the detection time for alerts that predate cursorTimestamp or
 * come from a fake client in a test
 */
function cursorTs(a) {
  return a.cursorTimestamp || a.timestamp;
}

/** Min and max of a comparable-ISO field across a cluster */
function spanOf(alerts, pick) {
  let min = null;
  let max = null;
  for (const a of alerts) {
    const v = pick(a);
    if (!v) continue;
    if (min === null || v < min) min = v;
    if (max === null || v > max) max = v;
  }
  return { min, max };
}

function makeGroup(alerts) {
  const sorted = [...alerts].sort((a, b) => ts(a) - ts(b));
  const ruleCounts = {};
  let topSeverity = 'unknown';
  for (const a of sorted) {
    const rn = a.ruleName || UNKNOWN_RULE;
    ruleCounts[rn] = (ruleCounts[rn] || 0) + 1;
    const sev = a.severity || 'unknown';
    if ((SEVERITY_RANK[sev] || 0) > (SEVERITY_RANK[topSeverity] || 0)) topSeverity = sev;
  }
  const representativeRule =
    Object.entries(ruleCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || UNKNOWN_RULE;

  // Taken over the whole cluster rather than off the first and last element:
  // `sorted` is ordered by detection time, so its ends are not necessarily the
  // ingest-time extremes
  const cursorSpan = spanOf(sorted, cursorTs);

  return {
    spaceId: sorted[0].spaceId,
    userName: sorted[0].userName,
    hostName: sorted[0].hostName,
    alerts: sorted,
    count: sorted.length,

    // Display (detection time)
    from: sorted[0].timestamp,
    to: sorted[sorted.length - 1].timestamp,

    // Query coordinates (ingest time) - what getRelatedAlerts ranges on
    queryFrom: cursorSpan.min,
    queryTo: cursorSpan.max,

    ruleCounts,
    topSeverity,
    representativeRule,
  };
}

/**
 * Cluster alerts by space + user + host within windowMs
 *
 * @param {Array} alerts   each: { id, index, spaceId, ruleName, severity, timestamp, cursorTimestamp, userName, hostName }
 * @param {number} windowMs
 * @returns {Array} groups (see makeGroup)
 */
function groupAlerts(alerts, windowMs) {
  const byKey = new Map();
  const singletons = [];

  for (const a of alerts) {
    if (a.userName && a.hostName) {
      const key = `${a.spaceId}\u0000${a.userName}\u0000${a.hostName}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(a);
    } else {
      singletons.push(a); // uncorrelatable > its own group
    }
  }

  const groups = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => ts(a) - ts(b));
    let cluster = [];
    let clusterStart = null;
    for (const a of list) {
      const t = ts(a);
      if (cluster.length === 0) {
        cluster = [a];
        clusterStart = t;
      } else if (t - clusterStart <= windowMs) {
        cluster.push(a);
      } else {
        groups.push(makeGroup(cluster));
        cluster = [a];
        clusterStart = t;
      }
    }
    if (cluster.length) groups.push(makeGroup(cluster));
  }
  for (const a of singletons) groups.push(makeGroup([a]));

  return groups;
}

/**
 * Compact value for the "Create case" button (Slack caps value at 2000 chars)
 * For a correlatable group we store the query coordinates and re-run the search
 * on click. For an uncorrelatable singleton we just carry the alert id
 *
 * f/t are the INGEST-time span, because that is the field getRelatedAlerts
 * ranges on. They are deliberately not the from/to shown in the message
 */
function encodeGroupValue(group) {
  if (group.userName && group.hostName) {
    return JSON.stringify({
      k: 'g',
      s: group.spaceId,
      u: group.userName,
      h: group.hostName,
      f: group.queryFrom ?? group.from,
      t: group.queryTo ?? group.to,
    });
  }
  return JSON.stringify({ k: 'a', a: group.alerts[0].id });
}

/** Parse a button value */
function decodeGroupValue(value) {
  try {
    const d = JSON.parse(value);
    if (d && (d.k === 'g' || d.k === 'a')) return d;
  } catch {
    // Not JSON - older buttons carried a bare alert id, and so does the
    // singleton path above
  }
  return { k: 'a', a: value };
}

module.exports = { groupAlerts, makeGroup, encodeGroupValue, decodeGroupValue };