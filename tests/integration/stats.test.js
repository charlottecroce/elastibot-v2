'use strict';

/*
 * /stats against a real cluster.
 *
 * getAlertStats is one large aggregation over half a dozen fields, and the ways it breaks are all invisible to a mock:
 *
 */

const config = require('../../config');
const { getAlertStatistics } = require('../../src/services/statsService');
const {
  adminClient,
  resetAlertsIndex,
  makeAlert,
  indexAlerts,
  minutesAgo,
} = require('./helpers/esFixtures');

const env = require('./env');

const apiKey = () => process.env.ELASTIBOT_TEST_API_KEY;

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
          rule: 'Suspicious PowerShell Execution',
          ruleUuid: 'rule-noisy',
          severity: i % 3 === 0 ? 'critical' : 'medium',
          host: `WEB-0${(i % 3) + 1}`,
          user: i % 2 === 0 ? 'jsmith' : 'adoe',
          process: 'powershell.exe',
        })
      );
    }
    for (let i = 0; i < 3; i += 1) {
      alerts.push(
        makeAlert({
          id: `stats-mid-${i}`,
          ingested: minutesAgo(100 + i),
          timestamp: minutesAgo(100 + i),
          rule: 'Malware Detected',
          ruleUuid: 'rule-mid',
          severity: 'high',
          host: 'DB-01',
          user: 'svc_backup',
          process: 'rundll32.exe',
        })
      );
    }
    alerts.push(
      makeAlert({
        id: 'stats-rare-0',
        ingested: minutesAgo(200),
        timestamp: minutesAgo(200),
        rule: 'Rare Process',
        ruleUuid: 'rule-rare',
        severity: 'low',
        host: 'LAP-99',
        user: 'contractor',
        process: 'notepad.exe',
      })
    );

    await indexAlerts(alerts);
  });

  test('the whole aggregation runs against a real mapping', async () => {
    const stats = await getAlertStatistics(apiKey(), '24h');

    expect(stats.total).toBe(16);
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
      `/${encodeURIComponent(env.alertsIndex)}/_field_caps`,
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
   * STATS_TIMEZONE is what hour-of-day and day-of-week are bucketed in. Node
   * and Elasticsearch both accept IANA names but not identical sets of them,
   * and a name Elastic doesn't know is a 400 at query time
   */
  test('STATS_TIMEZONE is a zone Elasticsearch accepts', async () => {
    const { data } = await adminClient().post(
      `/${encodeURIComponent(env.alertsIndex)}/_search`,
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
   * Cross-check the total against a _count built independently of our query
   * builder. If the two disagree, the range clause is off, and every number /stats prints 
   * is quietly wrong rather than obviously broken
   */
  test('the total agrees with an independent count over the same range', async () => {
    const stats = await getAlertStatistics(apiKey(), '24h');

    const { data } = await adminClient().post(
      `/${encodeURIComponent(env.alertsIndex)}/_count`,
      { query: { range: { '@timestamp': { gte: 'now-24h', lte: 'now' } } } }
    );

    expect(stats.total).toBe(data.count);
  });
});