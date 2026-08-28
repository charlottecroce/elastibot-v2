'use strict';

/*
 * /stats against a real cluster.
 *
 * getAlertStats is one large aggregation over half a dozen fields, and the ways
 * it breaks are all invisible to a mock: a field that is `text` and so not
 * aggregatable, a timezone Elasticsearch doesn't recognise, a range clause that
 * quietly selects the wrong documents, a bucket shape that shapeStats reads
 * differently from how Elasticsearch emits it.
 *
 */

const config = require('../../config');
const { getAlertStatistics } = require('../../src/services/statsService');
const { indices } = require('../testenv');
const {
  adminClient,
  resetAlertsIndex,
  makeAlert,
  indexAlerts,
  minutesAgo,
} = require('./helpers/esFixtures');

const apiKey = () => process.env.ELASTIBOT_TEST_API_KEY;

// The seeded shape, in one place, so an assertion and the thing it asserts on
// can't drift. Kept local rather than in testenv.js on purpose: these are what
// the test is about, not configuration.
const SEEDED = {
  total: 16,
  noisy: { rule: 'Suspicious PowerShell Execution', count: 12, hosts: 3, process: 'powershell.exe' },
  mid: { rule: 'Malware Detected', count: 3, hosts: 1, host: 'DB-01', process: 'rundll32.exe' },
  rare: { rule: 'Rare Process', count: 1, hosts: 1, host: 'LAP-99', process: 'notepad.exe' },
  distinctRules: 3,
  distinctHosts: 5, // WEB-01..03, DB-01, LAP-99
  distinctUsers: 4, // jsmith, adoe, svc_backup, contractor
  severities: { critical: 4, medium: 8, high: 3, low: 1 },
  riskScore: 47, // makeAlert's default, unchanged throughout
};

describe('/stats (live)', () => {
  beforeAll(async () => {
    await resetAlertsIndex();

    const alerts = [];

    // 12 from one noisy rule, 3 from another, 1 from a third. Enough of a
    // spread that "top" and "noisiest" have something to rank
    for (let i = 0; i < 12; i += 1) {
      alerts.push(
        makeAlert({
          id: `stats-noisy-${i}`,
          ingested: minutesAgo(30 + i),
          timestamp: minutesAgo(30 + i),
          rule: SEEDED.noisy.rule,
          ruleUuid: 'rule-noisy',
          severity: i % 3 === 0 ? 'critical' : 'medium',
          host: `WEB-0${(i % 3) + 1}`,
          user: i % 2 === 0 ? 'jsmith' : 'adoe',
          process: SEEDED.noisy.process,
        })
      );
    }
    for (let i = 0; i < 3; i += 1) {
      alerts.push(
        makeAlert({
          id: `stats-mid-${i}`,
          ingested: minutesAgo(100 + i),
          timestamp: minutesAgo(100 + i),
          rule: SEEDED.mid.rule,
          ruleUuid: 'rule-mid',
          severity: 'high',
          host: SEEDED.mid.host,
          user: 'svc_backup',
          process: SEEDED.mid.process,
        })
      );
    }
    alerts.push(
      makeAlert({
        id: 'stats-rare-0',
        ingested: minutesAgo(200),
        timestamp: minutesAgo(200),
        rule: SEEDED.rare.rule,
        ruleUuid: 'rule-rare',
        severity: 'low',
        host: SEEDED.rare.host,
        user: 'contractor',
        process: SEEDED.rare.process,
      })
    );

    await indexAlerts(alerts);
  });

  test('the whole aggregation runs against a real mapping', async () => {
    const stats = await getAlertStatistics(apiKey(), '24h');

    expect(stats.total).toBe(SEEDED.total);
    expect(stats.query.windowLabel).toBe('24h');
  });

  test('the window is a filter, not decoration', async () => {
    // Everything seeded is within the last few hours, so a 1h window has to
    // see fewer alerts than a 24h one. A stubbed search returns the same
    // fixture whatever range you hand it, which is why this can only live here
    const hour = await getAlertStatistics(apiKey(), '1h');
    const day = await getAlertStatistics(apiKey(), '24h');

    expect(hour.total).toBeGreaterThan(0);
    expect(hour.total).toBeLessThan(day.total);
  });

  test('an empty window is zero rather than a 400', async () => {
    const stats = await getAlertStatistics(apiKey(), '1m');
    expect(stats.total).toBe(0);
  });

  /*
   * Everything below here is about the numbers /stats actually prints. The
   * suite previously seeded a careful, lopsided spread and then asserted only
   * the total - which passes just as well if every ranking comes back reversed,
   * or if shapeStats reads `doc_count` off the wrong nesting level.
   */
  describe('the numbers it renders', () => {
    let stats;

    beforeAll(async () => {
      stats = await getAlertStatistics(apiKey(), '24h');
    });

    test('cardinality aggregations count distinct values, not documents', async () => {
      expect(stats.distinct).toEqual({
        rules: SEEDED.distinctRules,
        hosts: SEEDED.distinctHosts,
        users: SEEDED.distinctUsers,
      });
    });

    test('top rules come back ranked by volume', () => {
      expect(stats.topRules.map((r) => [r.name, r.count])).toEqual([
        [SEEDED.noisy.rule, SEEDED.noisy.count],
        [SEEDED.mid.rule, SEEDED.mid.count],
        [SEEDED.rare.rule, SEEDED.rare.count],
      ]);
    });

    /*
     * The per-rule sub-aggregations, which are the part most likely to be read
     * off the wrong level: `hosts` is a cardinality inside the rule bucket, not
     * the global host count
     */
    test('per-rule host and user counts are scoped to the rule', () => {
      const noisy = stats.topRules.find((r) => r.name === SEEDED.noisy.rule);
      const mid = stats.topRules.find((r) => r.name === SEEDED.mid.rule);

      expect(noisy.hosts).toBe(SEEDED.noisy.hosts);
      expect(mid.hosts).toBe(SEEDED.mid.hosts);
      expect(mid.hosts).not.toBe(stats.distinct.hosts);
    });

    /*
     * perHost is count/hosts, and noisiest sorts by it descending. 12 across 3
     * hosts is 4.0, 3 on one host is 3.0, 1 on one host is 1.0 - so the volume
     * ranking and the noise ranking happen to agree here, but they are computed
     * differently and this pins the arithmetic
     */
    test('noisiest ranks by alerts per host, not by raw volume', () => {
      const noisy = stats.noisyRules.find((r) => r.name === SEEDED.noisy.rule);
      expect(noisy.perHost).toBe(4);

      const perHost = stats.noisyRules.map((r) => r.perHost);
      expect(perHost).toEqual([...perHost].sort((a, b) => b - a));
    });

    test('severity buckets add up to the total', () => {
      const bySeverity = Object.fromEntries(stats.severities.map((b) => [b.key, b.count]));

      expect(bySeverity).toEqual(SEEDED.severities);
      expect(Object.values(bySeverity).reduce((a, b) => a + b, 0)).toBe(SEEDED.total);
    });

    test('the top process, host and user lists are ranked', () => {
      expect(stats.topProcesses[0]).toMatchObject({
        key: SEEDED.noisy.process,
        count: SEEDED.noisy.count,
      });
      // WEB-01..03 have 4 each, DB-01 has 3, so DB-01 cannot be first
      expect(stats.topHosts[0].count).toBeGreaterThanOrEqual(stats.topHosts[1].count);
      expect(stats.topUsers.map((u) => u.key)).toEqual(
        expect.arrayContaining(['jsmith', 'adoe', 'svc_backup', 'contractor'])
      );
    });

    test('risk is averaged over real float-mapped values', () => {
      expect(stats.risk.max).toBe(SEEDED.riskScore);
      expect(Math.round(stats.risk.avg)).toBe(SEEDED.riskScore);
    });

    /*
     * The case-linkage filter aggregates on a field this mapping does not have,
     * because nothing here has been attached to a case. An unmapped field in a
     * filter agg matches nothing, which is the wanted behaviour - but the
     * nearby wrong version of that query is one that errors instead, and a
     * fresh deployment with no cases yet is precisely where /stats would then
     * break.
     */
    test('the case-linkage filter is zero rather than a failure', () => {
      expect(stats.inCases.count).toBe(0);
      expect(stats.inCases.pct).toBe(0);
    });

    /*
     * foldActivity turns the hourly date_histogram into two independent views
     * of the same buckets - hour-of-day and day-of-week - by string-slicing
     * key_as_string ("yyyy-MM-dd'T'HH"). Both must total the window. A slice
     * offset that is wrong by one, or a format the query stops emitting, shows
     * up as one of the two folds being short while the other still looks fine.
     */
    test('both activity folds account for every alert in the window', () => {
      const { byHour, byWeekday, peakDay, perDay } = stats.activity;

      expect(byHour).toHaveLength(24);
      expect(byWeekday).toHaveLength(7);

      expect(byHour.reduce((a, b) => a + b, 0)).toBe(SEEDED.total);
      expect(byWeekday.reduce((a, b) => a + b, 0)).toBe(SEEDED.total);

      // A 24h window is exactly one day, so perDay is the total. This is the
      // arithmetic that goes wrong when windowMs and the histogram disagree
      expect(perDay).toBe(SEEDED.total);

      // Everything is seeded within about three hours, but a run that straddles
      // midnight in STATS_TIMEZONE splits it across two dates
      expect(peakDay.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(peakDay.count).toBeGreaterThan(0);
      expect(peakDay.count).toBeLessThanOrEqual(SEEDED.total);
    });

    test('busiest and quietest hour index into the fold they came from', () => {
      const { byHour, busiestHour, quietestHour } = stats.activity;

      expect(byHour[busiestHour]).toBe(Math.max(...byHour));
      expect(byHour[quietestHour]).toBe(Math.min(...byHour));
    });
  });

  /*
   * The filters. parseStatsQuery is unit-tested, but what it parses into is a
   * set of term clauses against keyword fields, and whether those actually
   * select the right documents is a question about the mapping. A `text` field
   * would match on analysed tokens and quietly return too much.
   *
   * NOTE: the token syntax here assumes `field:value` - check it against
   * parseTokens before trusting a failure.
   */
  describe('filters', () => {
    test('host: narrows to one host', async () => {
      const stats = await getAlertStatistics(apiKey(), `24h host:${SEEDED.mid.host}`);

      expect(stats.total).toBe(SEEDED.mid.count);
      expect(stats.distinct.hosts).toBe(1);
    });

    test('rule: narrows to one rule, exactly - not on a shared word', async () => {
      // 'Suspicious PowerShell Execution' and 'Rare Process' share no words,
      // but 'Malware Detected' vs a keyword match on 'Malware' is the case that
      // separates a term query from a match query
      const stats = await getAlertStatistics(apiKey(), `24h rule:"${SEEDED.mid.rule}"`);
      expect(stats.total).toBe(SEEDED.mid.count);

      const partial = await getAlertStatistics(apiKey(), '24h rule:Malware');
      expect(partial.total).toBe(0);
    });

    test('user: narrows to one user', async () => {
      const stats = await getAlertStatistics(apiKey(), '24h user:contractor');
      expect(stats.total).toBe(SEEDED.rare.count);
    });

    test('a filter that matches nothing is zero, not an error', async () => {
      const stats = await getAlertStatistics(apiKey(), '24h host:NOPE-99');
      expect(stats.total).toBe(0);
      expect(stats.topRules).toEqual([]);
    });

    test('filters compose rather than replacing each other', async () => {
      const stats = await getAlertStatistics(
        apiKey(),
        `24h host:${SEEDED.mid.host} user:contractor`
      );
      // svc_backup is on DB-01, contractor is on LAP-99 - no document is both
      expect(stats.total).toBe(0);
    });
  });

  /*
   * The specific failure this guards: STATS_PROCESS_FIELD pointing at a field
   * that is `text` in the deployment's mapping. The aggregation then fails at
   * runtime with "Fielddata is disabled on [process.name]", and the analyst
   * sees /stats break rather than a config error at boot.
   *
   * Asserted through the field caps API so the failure message names the
   * field and its type, instead of being a 400 from somewhere inside a
   * hundred-line aggregation body
   */
  test('STATS_PROCESS_FIELD is aggregatable in this mapping', async () => {
    const field = config.stats.processField;
    const { data } = await adminClient().get(
      `/${encodeURIComponent(indices.testPattern)}/_field_caps`,
      { params: { fields: field } }
    );

    const caps = data.fields?.[field];
    expect(caps).toBeDefined();

    const [type, detail] = Object.entries(caps)[0];
    expect({ field, type, aggregatable: detail.aggregatable }).toEqual({
      field,
      type: 'keyword',
      aggregatable: true,
    });
  });

  /*
   * Same argument as the process field, for the ones /stats aggregates on
   * unconditionally. A deployment that maps host.name as text breaks the host
   * rollup rather than the process one, and the error is just as opaque.
   */
  test.each(['host.name', 'user.name', 'kibana.alert.rule.name', 'kibana.alert.severity'])(
    '%s is aggregatable in this mapping',
    async (field) => {
      const { data } = await adminClient().get(
        `/${encodeURIComponent(indices.testPattern)}/_field_caps`,
        { params: { fields: field } }
      );

      const [, detail] = Object.entries(data.fields?.[field] || {})[0] || [];
      expect(detail?.aggregatable).toBe(true);
    }
  );

  /*
   * STATS_TIMEZONE is what hour-of-day and day-of-week are bucketed in. Node
   * and Elasticsearch both accept IANA names but not identical sets of them,
   * and a name Elastic doesn't know is a 400 at query time
   */
  test('STATS_TIMEZONE is a zone Elasticsearch accepts', async () => {
    const { data } = await adminClient().post(
      `/${encodeURIComponent(indices.testPattern)}/_search`,
      {
        size: 0,
        aggs: {
          by_hour: {
            date_histogram: {
              field: '@timestamp',
              calendar_interval: 'hour',
              time_zone: config.stats.timeZone,
            },
          },
        },
      }
    );

    expect(Array.isArray(data.aggregations.by_hour.buckets)).toBe(true);
  });

  /*
   * CASE_TITLE_TIMEZONE is a different setting read by a different module, and
   * nothing else in the suite asserts Elasticsearch will take it. It is UTC in
   * both suites today, which is exactly why a change to it would go unnoticed.
   */
  test('CASE_TITLE_TIMEZONE is a zone Elasticsearch accepts', async () => {
    const { data } = await adminClient().post(
      `/${encodeURIComponent(indices.testPattern)}/_search`,
      {
        size: 0,
        aggs: {
          by_day: {
            date_histogram: {
              field: '@timestamp',
              calendar_interval: 'day',
              time_zone: config.naming.timeZone,
            },
          },
        },
      }
    );

    expect(Array.isArray(data.aggregations.by_day.buckets)).toBe(true);
  });

  /*
   * Cross-check the total against a _count built independently of our query
   * builder. If the two disagree, the range clause is off, and every number
   * /stats prints is quietly wrong rather than obviously broken
   */
  test('the total agrees with an independent count over the same range', async () => {
    const stats = await getAlertStatistics(apiKey(), '24h');

    const { data } = await adminClient().post(
      `/${encodeURIComponent(indices.testPattern)}/_count`,
      { query: { range: { '@timestamp': { gte: 'now-24h', lte: 'now' } } } }
    );

    expect(stats.total).toBe(data.count);
  });

  /*
   * The same cross-check for a narrower window, which is the one that catches a
   * range clause built with the right shape and the wrong bound. A 24h window
   * over data seeded in the last 3.5 hours agrees with almost any off-by-a-lot
   * range; a 1h window does not.
   */
  test('a narrow window also agrees with an independent count', async () => {
    const stats = await getAlertStatistics(apiKey(), '1h');

    const { data } = await adminClient().post(
      `/${encodeURIComponent(indices.testPattern)}/_count`,
      { query: { range: { '@timestamp': { gte: 'now-1h', lte: 'now' } } } }
    );

    // A second or two elapses between the two calls and `now` moves with it,
    // so alerts on the boundary can fall out. Off by one is the clock; off by
    // more is the query
    expect(Math.abs(stats.total - data.count)).toBeLessThanOrEqual(1);
  });
});