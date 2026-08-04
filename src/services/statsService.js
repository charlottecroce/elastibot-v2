'use strict';

const config = require('../../config');
const { createElasticClient } = require('../elastic');
const { UserFacingError, describeAxiosError } = require('./caseService');

/*
 * /stats - the numbers behind the alerts index
 *
 * Everything comes out of ONE size:0 aggregation search (client.getAlertStats),
 * so the cost barely moves between a 1 hour and a 30 day window. Nothing here
 * pages through documents
 *
 * "noisiest" ranks by alerts per DISTINCT host, not raw volume
 */

const WINDOW_RE = /^(\d+)(m|h|d|w)$/i;
const UNIT_MS = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
const FILTER_KEYS = ['rule', 'host', 'user', 'space'];
const DAY_MS = 86400000;

/**
 * Split command text into { key, value } tokens, keeping "quoted values" whole
 * Handles:  30d   host:web-01   rule:"Suspicious PowerShell"   share
 */
function parseTokens(text) {
  const tokens = [];
  const re = /([a-z_]+):"([^"]*)"|([a-z_]+):(\S+)|"([^"]*)"|(\S+)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    if (m[1] !== undefined) tokens.push({ key: m[1].toLowerCase(), value: m[2] });
    else if (m[3] !== undefined) tokens.push({ key: m[3].toLowerCase(), value: m[4] });
    else tokens.push({ key: null, value: m[5] !== undefined ? m[5] : m[6] });
  }
  return tokens;
}

/** "30d" > milliseconds. Throws (user-facing) on junk or an over-long window */
function windowToMs(windowStr) {
  const m = WINDOW_RE.exec(String(windowStr || '').trim());
  if (!m) {
    throw new UserFacingError(
      `\`${windowStr}\` isn't a window I understand — try \`24h\`, \`7d\` or \`2w\`.`
    );
  }
  const ms = Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
  const cap = config.stats.maxWindowDays * DAY_MS;
  if (ms <= 0) throw new UserFacingError('The window has to be longer than zero.');
  if (ms > cap) {
    throw new UserFacingError(
      `That window is longer than the ${config.stats.maxWindowDays} day cap ` +
        '(raise `STATS_MAX_WINDOW_DAYS` if you really want it).'
    );
  }
  return ms;
}

/**
 * Parse the raw slash-command text into a query descriptor
 * @returns {{windowLabel,from,to,timeZone,filters,share}}
 */
function parseStatsQuery(text, now = new Date()) {
  const filters = {};
  let windowLabel = config.stats.defaultWindow;
  let share = false;

  for (const t of parseTokens(text)) {
    if (t.key) {
      if (!FILTER_KEYS.includes(t.key)) {
        throw new UserFacingError(
          `Unknown filter \`${t.key}:\` — I know ${FILTER_KEYS.map((k) => `\`${k}:\``).join(', ')}.`
        );
      }
      if (t.value) filters[t.key] = t.value;
      continue;
    }
    const v = t.value.toLowerCase();
    if (v === 'share') {
      share = true;
    } else if (WINDOW_RE.test(v)) {
      windowLabel = v;
    } else {
      throw new UserFacingError(`I don't know what to do with \`${t.value}\`.`);
    }
  }

  const ms = windowToMs(windowLabel);
  return {
    windowLabel: windowLabel.toLowerCase(),
    windowMs: ms,
    from: new Date(now.getTime() - ms).toISOString(),
    to: now.toISOString(),
    timeZone: config.stats.timeZone,
    filters,
    share,
  };
}

/** ES terms buckets > [{ key, count }] */
function buckets(agg) {
  return (agg?.buckets || []).map((b) => ({ key: String(b.key), count: b.doc_count }));
}

function pct(part, whole) {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

/**
 * Fold the hourly date_histogram into hour-of-day / day-of-week / per-date views
 * Buckets are formatted "yyyy-MM-dd'T'HH" in config.stats.timeZone, so the local
 * hour is just the string - no timezone maths on our side
 */
function foldActivity(overTime, windowMs) {
  const byHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0);
  const byDate = new Map();

  for (const b of overTime?.buckets || []) {
    const key = b.key_as_string || '';
    const date = key.slice(0, 10);
    const hour = Number(key.slice(11, 13));
    if (Number.isInteger(hour) && hour >= 0 && hour < 24) byHour[hour] += b.doc_count;
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      byDate.set(date, (byDate.get(date) || 0) + b.doc_count);
      // Parse as UTC so the weekday reflects the bucket's own date, whatever
      // timezone the bot process happens to run in
      byWeekday[new Date(`${date}T00:00:00Z`).getUTCDay()] += b.doc_count;
    }
  }

  let peakDay = null;
  for (const [date, count] of byDate) {
    if (!peakDay || count > peakDay.count) peakDay = { date, count };
  }

  const total = byHour.reduce((a, b) => a + b, 0);
  return {
    byHour,
    byWeekday,
    peakDay,
    busiestHour: byHour.indexOf(Math.max(...byHour)),
    quietestHour: byHour.indexOf(Math.min(...byHour)),
    perDay: Math.round(total / Math.max(1, windowMs / DAY_MS)),
  };
}

/**
 * Turn the raw aggregation response into the object statsBlocks renders 
 * the tests feed it a fixture instead of a cluster
 */
function shapeStats(raw, query, opts = {}) {
  const {
    topN = config.stats.topN,
    noiseMinAlerts = config.stats.noiseMinAlerts,
  } = opts;
  const aggs = raw?.aggregations || {};
  const total = raw?.hits?.total?.value ?? 0;

  const rules = (aggs.rules?.buckets || []).map((b) => {
    const cased = b.in_cases?.doc_count || 0;
    const hosts = b.hosts?.value || 0;
    return {
      name: b.key,
      count: b.doc_count,
      hosts,
      users: b.users?.value || 0,
      avgRisk: Math.round(b.risk?.value || 0),
      inCases: cased,
      caseRate: pct(cased, b.doc_count),
      perHost: Math.round((b.doc_count / Math.max(1, hosts)) * 10) / 10,
      lastSeen: b.last_seen?.value_as_string || null,
    };
  });

  const loud = rules.filter((r) => r.count >= noiseMinAlerts);

  return {
    query,
    total,
    distinct: {
      rules: aggs.rule_count?.value || 0,
      hosts: aggs.host_count?.value || 0,
      users: aggs.user_count?.value || 0,
    },
    inCases: {
      count: aggs.in_cases?.doc_count || 0,
      pct: pct(aggs.in_cases?.doc_count || 0, total),
    },
    risk: { avg: aggs.risk?.avg || 0, max: aggs.risk?.max || 0 },
    severities: buckets(aggs.severities),
    workflow: buckets(aggs.workflow),
    topRules: rules.slice(0, topN),
    noisyRules: [...loud].sort((a, b) => b.perHost - a.perHost).slice(0, topN),
    topHosts: buckets(aggs.hosts),
    topUsers: buckets(aggs.users),
    topProcesses: buckets(aggs.processes),
    topSpaces: buckets(aggs.spaces),
    activity: foldActivity(aggs.over_time, query.windowMs),
  };
}

/**
 * /stats end to end: parse > query Elastic with the analyst's key > shape
 *
 * @param {string} apiKey  the analyst's Elastic API key
 * @param {string} text    raw slash-command text
 */
async function getAlertStatistics(apiKey, text, now = new Date()) {
  const query = parseStatsQuery(text, now);
  const client = createElasticClient(apiKey);

  let raw;
  try {
    raw = await client.getAlertStats({
      from: query.from,
      to: query.to,
      spaceId: query.filters.space,
      ruleName: query.filters.rule,
      hostName: query.filters.host,
      userName: query.filters.user,
      topN: config.stats.topN,
      timeZone: query.timeZone,
    });
  } catch (err) {
    throw describeAxiosError(err, 'Building statistics');
  }

  return shapeStats(raw, query);
}

module.exports = {
  getAlertStatistics,
  parseStatsQuery,
  parseTokens,
  windowToMs,
  shapeStats,
  foldActivity,
};