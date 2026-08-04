'use strict';

jest.mock('../src/elastic', () => ({ createElasticClient: jest.fn() }));

const { createElasticClient } = require('../src/elastic');
const {
  parseStatsQuery,
  windowToMs,
  shapeStats,
  getAlertStatistics,
} = require('../src/services/statsService');
const { UserFacingError } = require('../src/services/caseService');
const { statsBlocks } = require('../src/services/format');

/*
 * /stats is one aggregation query plus a pile of arithmetic. The query itself is
 * Elastic's problem- the arithmetic (noise ratios, folding hourly buckets into hour-of-day and weekday) is what's tested
 */

const NOW = new Date('2026-07-30T12:00:00.000Z');

/** A response shaped like what ES gives us back */
function fixture() {
  return {
    hits: { total: { value: 100 } },
    aggregations: {
      rules: {
        buckets: [
          {
            key: 'Noisy Rule',
            doc_count: 60,
            hosts: { value: 1 },
            users: { value: 1 },
            risk: { value: 21 },
            last_seen: { value_as_string: '2026-07-30T11:00:00.000Z' },
            in_cases: { doc_count: 0 },
          },
          {
            key: 'Real Detection',
            doc_count: 30,
            hosts: { value: 15 },
            users: { value: 10 },
            risk: { value: 73 },
            last_seen: { value_as_string: '2026-07-30T10:00:00.000Z' },
            in_cases: { doc_count: 9 },
          },
          {
            key: 'Rare Rule',
            doc_count: 5,
            hosts: { value: 1 },
            users: { value: 1 },
            risk: { value: 50 },
            last_seen: { value_as_string: '2026-07-29T10:00:00.000Z' },
            in_cases: { doc_count: 0 },
          },
        ],
      },
      severities: { buckets: [{ key: 'low', doc_count: 60 }, { key: 'high', doc_count: 40 }] },
      workflow: { buckets: [{ key: 'open', doc_count: 70 }, { key: 'closed', doc_count: 30 }] },
      hosts: { buckets: [{ key: 'web-01', doc_count: 60 }, { key: 'web-02', doc_count: 20 }] },
      users: { buckets: [{ key: 'jsmith', doc_count: 50 }] },
      processes: { buckets: [{ key: 'powershell.exe', doc_count: 55 }] },
      spaces: { buckets: [{ key: 'default', doc_count: 100 }] },
      rule_count: { value: 3 },
      host_count: { value: 16 },
      user_count: { value: 11 },
      risk: { avg: 40.5, max: 99 },
      in_cases: { doc_count: 9 },
      over_time: {
        buckets: [
          { key_as_string: '2026-07-28T09', doc_count: 10 }, // Tuesday
          { key_as_string: '2026-07-28T13', doc_count: 5 },
          { key_as_string: '2026-07-29T09', doc_count: 20 }, // Wednesday
          { key_as_string: '2026-07-30T02', doc_count: 1 },  // Thursday
        ],
      },
    },
  };
}

describe('windowToMs', () => {
  test('understands minutes, hours, days and weeks', () => {
    expect(windowToMs('30m')).toBe(1800000);
    expect(windowToMs('24h')).toBe(86400000);
    expect(windowToMs('7d')).toBe(604800000);
    expect(windowToMs('2w')).toBe(1209600000);
  });

  test('rejects junk with a user-facing message', () => {
    expect(() => windowToMs('banana')).toThrow(UserFacingError);
    expect(() => windowToMs('7')).toThrow(/window I understand/);
    expect(() => windowToMs('0d')).toThrow(/longer than zero/);
  });

  test('rejects a window past the configured cap', () => {
    expect(() => windowToMs('91d')).toThrow(/90 day cap/);
    expect(() => windowToMs('90d')).not.toThrow();
  });
});

describe('parseStatsQuery', () => {
  test('bare /stats uses the configured default window', () => {
    const q = parseStatsQuery('', NOW);
    expect(q.windowLabel).toBe('7d');
    expect(q.to).toBe('2026-07-30T12:00:00.000Z');
    expect(q.from).toBe('2026-07-23T12:00:00.000Z');
    expect(q.filters).toEqual({});
    expect(q.share).toBe(false);
  });

  test('a bare window token sets the range', () => {
    expect(parseStatsQuery('24h', NOW).from).toBe('2026-07-29T12:00:00.000Z');
  });

  test('filters and the share flag parse in any order', () => {
    const q = parseStatsQuery('share host:web-01 30d user:jsmith', NOW);
    expect(q.windowLabel).toBe('30d');
    expect(q.share).toBe(true);
    expect(q.filters).toEqual({ host: 'web-01', user: 'jsmith' });
  });

  test('a quoted filter value keeps its spaces', () => {
    const q = parseStatsQuery('rule:"Suspicious PowerShell Download"', NOW);
    expect(q.filters.rule).toBe('Suspicious PowerShell Download');
  });

  test('an unknown filter key is rejected by name', () => {
    expect(() => parseStatsQuery('banana:1', NOW)).toThrow(/Unknown filter/);
  });

  test('an unrecognised bare token is rejected rather than ignored', () => {
    expect(() => parseStatsQuery('lastweek', NOW)).toThrow(UserFacingError);
  });

  test('the timezone comes from config, not the host', () => {
    expect(parseStatsQuery('', NOW).timeZone).toBe('UTC');
  });
});

describe('shapeStats', () => {
  const query = parseStatsQuery('', NOW);
  const stats = shapeStats(fixture(), query);

  test('headline counters', () => {
    expect(stats.total).toBe(100);
    expect(stats.distinct).toEqual({ rules: 3, hosts: 16, users: 11 });
    expect(stats.inCases).toEqual({ count: 9, pct: 9 });
    expect(stats.risk).toEqual({ avg: 40.5, max: 99 });
  });

  test('rules are ranked by volume, with a per-rule case rate', () => {
    expect(stats.topRules.map((r) => r.name)).toEqual([
      'Noisy Rule',
      'Real Detection',
      'Rare Rule',
    ]);
    expect(stats.topRules[1]).toMatchObject({ count: 30, hosts: 15, caseRate: 30, avgRisk: 73 });
  });

  test('noisiest is alerts per distinct host, not raw volume', () => {
    // 60 alerts on 1 host beats 30 alerts spread over 15
    expect(stats.noisyRules[0]).toMatchObject({ name: 'Noisy Rule', perHost: 60 });
    expect(stats.noisyRules[1]).toMatchObject({ name: 'Real Detection', perHost: 2 });
  });

  test('noisiest ignores rules below the noise floor', () => {
    // Rare Rule is 5 alerts on 1 host - a worse ratio than anything else here,
    // but 5 alerts is not a pattern
    expect(stats.noisyRules.map((r) => r.name)).not.toContain('Rare Rule');
  });

  test('top-N lists come straight off the buckets', () => {
    expect(stats.topHosts[0]).toEqual({ key: 'web-01', count: 60 });
    expect(stats.topProcesses[0]).toEqual({ key: 'powershell.exe', count: 55 });
    expect(stats.severities.map((s) => s.key)).toEqual(['low', 'high']);
  });

  test('hourly buckets fold into hour-of-day', () => {
    const { byHour } = stats.activity;
    expect(byHour).toHaveLength(24);
    expect(byHour[9]).toBe(30); // 10 on the 28th + 20 on the 29th
    expect(byHour[13]).toBe(5);
    expect(byHour[2]).toBe(1);
    expect(stats.activity.busiestHour).toBe(9);
  });

  test('hourly buckets fold into day-of-week', () => {
    const { byWeekday } = stats.activity;
    expect(byWeekday).toHaveLength(7);
    expect(byWeekday[2]).toBe(15); // Tuesday the 28th
    expect(byWeekday[3]).toBe(20); // Wednesday the 29th
    expect(byWeekday[4]).toBe(1);  // Thursday the 30th
    expect(byWeekday[0]).toBe(0);
  });

  test('peak day and per-day average', () => {
    expect(stats.activity.peakDay).toEqual({ date: '2026-07-29', count: 20 });
    expect(stats.activity.perDay).toBe(5); // 36 alerts over a 7 day window
  });

  test('an empty index shapes cleanly instead of dividing by zero', () => {
    const empty = shapeStats({ hits: { total: { value: 0 } }, aggregations: {} }, query);
    expect(empty.total).toBe(0);
    expect(empty.inCases.pct).toBe(0);
    expect(empty.topRules).toEqual([]);
    expect(empty.noisyRules).toEqual([]);
    expect(empty.activity.byHour.every((h) => h === 0)).toBe(true);
    expect(empty.activity.peakDay).toBeNull();
  });

  test('a missing aggregation response does not throw', () => {
    expect(() => shapeStats(undefined, query)).not.toThrow();
  });
});

describe('getAlertStatistics', () => {
  test('passes the parsed window, filters and timezone to Elastic', async () => {
    const client = { getAlertStats: jest.fn().mockResolvedValue(fixture()) };
    createElasticClient.mockReturnValue(client);

    const stats = await getAlertStatistics('api-key', '24h host:web-01 space:soc', NOW);

    expect(createElasticClient).toHaveBeenCalledWith('api-key');
    expect(client.getAlertStats).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '2026-07-29T12:00:00.000Z',
        to: '2026-07-30T12:00:00.000Z',
        hostName: 'web-01',
        spaceId: 'soc',
        ruleName: undefined,
        timeZone: 'UTC',
      })
    );
    expect(stats.total).toBe(100);
    expect(stats.query.windowLabel).toBe('24h');
  });

  test('a rejected API key is a friendly error', async () => {
    createElasticClient.mockReturnValue({
      getAlertStats: jest.fn().mockRejectedValue(
        Object.assign(new Error('failed'), { response: { status: 403, data: {} } })
      ),
    });
    await expect(getAlertStatistics('api-key', '', NOW)).rejects.toThrow(/Re-run `\/start`/);
  });

  test('bad arguments never reach Elastic', async () => {
    const client = { getAlertStats: jest.fn() };
    createElasticClient.mockReturnValue(client);
    await expect(getAlertStatistics('api-key', '5y', NOW)).rejects.toThrow(UserFacingError);
    expect(client.getAlertStats).not.toHaveBeenCalled();
  });
});

describe('statsBlocks', () => {
  const stats = shapeStats(fixture(), parseStatsQuery('30d host:web-01', NOW));
  const blocks = statsBlocks(stats);

  test('stays inside Slack limits', () => {
    expect(blocks.length).toBeLessThanOrEqual(50);
    for (const b of blocks) {
      if (b.text) expect(b.text.text.length).toBeLessThanOrEqual(3000);
      for (const el of b.elements || []) {
        if (el.text) expect(String(el.text.text ?? el.text).length).toBeLessThanOrEqual(3000);
      }
    }
  });

  test('every block is a type Slack knows', () => {
    const allowed = new Set(['section', 'context', 'divider', 'actions', 'header']);
    expect(blocks.every((b) => allowed.has(b.type))).toBe(true);
  });

  test('renders the sections that matter', () => {
    const text = JSON.stringify(blocks);
    expect(text).toContain('Top rules by volume');
    expect(text).toContain('Noisiest rules');
    expect(text).toContain('By hour of day');
    expect(text).toContain('Noisy Rule');
    expect(text).toContain('powershell.exe');
  });

  test('echoes the window and active filters back', () => {
    const text = JSON.stringify(blocks);
    expect(text).toContain('last *30d*');
    expect(text).toContain('web-01');
  });

  test('an empty result says so instead of rendering empty tables', () => {
    const empty = statsBlocks(
      shapeStats({ hits: { total: { value: 0 } }, aggregations: {} }, parseStatsQuery('', NOW))
    );
    expect(empty.length).toBeLessThan(5);
    expect(JSON.stringify(empty)).toContain('No alerts matched');
  });
});