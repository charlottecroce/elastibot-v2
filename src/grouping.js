'use strict';

const config = require('../config');
const { UNKNOWN_RULE, SEVERITY_RANK } = require('./constants');

/*
 * Alert grouping
 *
 * A burst of alerts from the same user on the same host (same space), close
 * together in time, is really one incident - even if the alerts fire different
 * rules. We collapse such bursts into one group so the channel shows one message
 * per incident, and so a case attaches the whole burst
 *
 * PASS 1  cluster on spaceId + user.name + host.name within windowMs
 * PASS 2  fold machine-identity clusters into the human cluster on the same host
 *
 * Two distinct human users on one host still stay separate. A shared jump box
 * with jsmith and adoe on it is two investigations, and merging them would put
 * one analyst's alerts in the other's case
 *
 * TWO CLOCKS
 *
 *   alert.timestamp        detection time (kibana.alert.@timestamp, falling back
 *                          to @timestamp). What a human means by "when did this
 *                          fire". Clustering and display use this one
 *   alert.cursorTimestamp  ingest time (@timestamp). What Elastic ranges and
 *                          sorts on. Only watchers/alerts.js touches it, to
 *                          advance its poll cursor
 *
 * Nothing here hands a timestamp back to a query any more - cases are built
 * from an explicit alert id list - so detection time is all this file needs
 */

const SEP = '\u0000';

/** Detection time - clustering and display */
function ts(a) {
  const t = Date.parse(a.timestamp);
  return Number.isNaN(t) ? 0 : t;
}

/*
 * ---- machine identities -------------------------------------------------
 */

/** `NT AUTHORITY\SYSTEM` and `CORP\svc_backup` are the same names as SYSTEM and
 *  svc_backup - strip the domain before matching */
function bareUser(name) {
  if (!name) return null;
  const s = String(name).trim();
  if (!s) return null;
  const slash = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return slash >= 0 ? s.slice(slash + 1) : s;
}

/** Config gives globs (`svc_*`); turn them into anchored, case-insensitive REs */
function globToRe(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

const machineMatchers = (config.grouping.machineUsers || []).map(globToRe);

/**
 * Does this identity tell us anything about *who* was at the keyboard?
 *
 * Absent counts as machine: an alert with no user.name can't contradict a match
 * either, and treating it as machine is what finally gets those alerts out of
 * the singleton bucket they used to land in
 */
function isMachineUser(name) {
  const bare = bareUser(name);
  if (!bare) return true;
  if (bare.endsWith('$')) return true; // AD computer account, e.g. WEB-01$
  return machineMatchers.some((re) => re.test(bare));
}

/*
 * ---- group construction -------------------------------------------------
 */

function makeGroup(alerts) {
  const sorted = [...alerts].sort((a, b) => ts(a) - ts(b));
  const ruleCounts = {};
  const userCounts = {};
  let topSeverity = 'unknown';

  for (const a of sorted) {
    const rn = a.ruleName || UNKNOWN_RULE;
    ruleCounts[rn] = (ruleCounts[rn] || 0) + 1;
    const sev = a.severity || 'unknown';
    if ((SEVERITY_RANK[sev] || 0) > (SEVERITY_RANK[topSeverity] || 0)) topSeverity = sev;

    /*
     * Counted on the bare name. `SYSTEM` and `NT AUTHORITY\SYSTEM` are one
     * identity, and if they stay distinct here they become two entries in
     * userNames - which is what incidents.findMatch compares across polls. The
     * same account arriving under both spellings would then look like two
     * different users on one host and split the incident
     */
    const u = bareUser(a.userName);
    if (u) userCounts[u] = (userCounts[u] || 0) + 1;
  }

  const representativeRule =
    Object.entries(ruleCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || UNKNOWN_RULE;

  const userNames = Object.keys(userCounts);
  const humans = userNames.filter((u) => !isMachineUser(u));

  /*
   * The name on the message. A human identity always wins the label even if
   * SYSTEM fired more of the alerts - "12 alerts on web-01 (SYSTEM)" tells an
   * analyst nothing, "12 alerts, jsmith on web-01" tells them more
   */
  const primaryUser =
    humans.sort((a, b) => userCounts[b] - userCounts[a])[0] ||
    userNames.sort((a, b) => userCounts[b] - userCounts[a])[0] ||
    null;

  return {
    spaceId: sorted[0].spaceId,
    hostName: sorted[0].hostName || null,

    userName: primaryUser,
    userNames,                          // every identity in the burst
    machineOnly: humans.length === 0,   // nothing here says who was driving
    machineUsers: userNames.filter(isMachineUser),

    alerts: sorted,
    count: sorted.length,

    from: sorted[0].timestamp,
    to: sorted[sorted.length - 1].timestamp,

    ruleCounts,
    userCounts,
    topSeverity,
    representativeRule,
  };
}

/** Do two clusters sit close enough in time to be one incident? */
function overlaps(a, b, windowMs) {
  const aFrom = Date.parse(a.from);
  const aTo = Date.parse(a.to);
  const bFrom = Date.parse(b.from);
  const bTo = Date.parse(b.to);
  return bFrom - aTo <= windowMs && aFrom - bTo <= windowMs;
}

/** Cluster one key's alerts on detection time, window measured from the first */
function clusterByTime(list, windowMs) {
  list.sort((a, b) => ts(a) - ts(b));
  const clusters = [];
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
      clusters.push(cluster);
      cluster = [a];
      clusterStart = t;
    }
  }
  if (cluster.length) clusters.push(cluster);
  return clusters;
}

/*
 * Pass 2. Within one space+host, absorb machine-identity clusters into the
 * human cluster they overlap
 *
 * Ambiguity rule: if a machine cluster overlaps more than one human cluster we
 * give it to the nearest in time.
 */
function mergeMachineClusters(clustersOnHost, windowMs) {
  const groups = clustersOnHost.map(makeGroup);
  const humans = groups.filter((g) => !g.machineOnly);
  const machines = groups.filter((g) => g.machineOnly);

  if (!machines.length) return groups;

  // Nobody human on this host: fold every overlapping machine cluster together
  // so a box running only service accounts still gets one message, not six
  if (!humans.length) {
    const out = [];
    for (const m of machines) {
      const target = out.find((g) => overlaps(g, m, windowMs));
      if (target) target.alerts.push(...m.alerts);
      else out.push(m);
    }
    return out.map((g) => makeGroup(g.alerts));
  }

  const absorbed = new Map(humans.map((h) => [h, [...h.alerts]]));
  const orphans = [];

  for (const m of machines) {
    const candidates = humans.filter((h) => overlaps(h, m, windowMs));
    if (!candidates.length) {
      orphans.push(m);
      continue;
    }
    const mid = (Date.parse(m.from) + Date.parse(m.to)) / 2;
    const nearest = candidates.sort((x, y) => {
      const dx = Math.abs((Date.parse(x.from) + Date.parse(x.to)) / 2 - mid);
      const dy = Math.abs((Date.parse(y.from) + Date.parse(y.to)) / 2 - mid);
      return dx - dy;
    })[0];
    absorbed.get(nearest).push(...m.alerts);
  }

  return [...[...absorbed.values()].map(makeGroup), ...orphans];
}

/**
 * Cluster alerts into incidents
 *
 * @param {Array} alerts   each: { id, index, spaceId, ruleName, severity, timestamp, cursorTimestamp, userName, hostName }
 * @param {number} windowMs
 * @param {object} [opts]
 * @param {boolean} [opts.mergeMachineUsers] pass 2 on/off (config default)
 * @returns {Array} groups (see makeGroup)
 */
function groupAlerts(alerts, windowMs, opts = {}) {
  const mergeMachine = opts.mergeMachineUsers ?? config.grouping.mergeMachineUsers;

  // Pass 1: spaceId + user + host. An alert with no host still can't be
  // correlated to anything, so it stays a singleton
  const byKey = new Map();
  const hostless = [];

  for (const a of alerts) {
    if (!a.hostName) {
      hostless.push(a);
      continue;
    }
    const key = `${a.spaceId}${SEP}${a.hostName}${SEP}${a.userName || ''}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(a);
  }

  // Re-bucket the time clusters under their host so pass 2 can see across users
  const byHost = new Map();
  for (const [key, list] of byKey) {
    const hostKey = key.slice(0, key.lastIndexOf(SEP));
    if (!byHost.has(hostKey)) byHost.set(hostKey, []);
    byHost.get(hostKey).push(...clusterByTime(list, windowMs));
  }

  const groups = [];
  for (const clusters of byHost.values()) {
    if (mergeMachine) groups.push(...mergeMachineClusters(clusters, windowMs));
    else groups.push(...clusters.map(makeGroup));
  }
  for (const a of hostless) groups.push(makeGroup([a]));

  return groups;
}

/*
 * ---- button values ------------------------------------------------------
 *
 * A button carries the incident key, as a bare string, and nothing else.
 *
 */

module.exports = { groupAlerts, makeGroup, isMachineUser, bareUser };