'use strict';

/*
 * src/elastic.js against a real cluster.
 *
 * The unit suite already proves this code does the right thing with a mocked
 * axios. What it cannot prove is that the requests it builds are ones
 * Elasticsearch accepts, that the mapping supports them, and that a real
 * response maps onto the alert shape the rest of the app assumes. That is all
 * this file is for. If an assertion here can be made to pass with a mock, it
 * belongs in tests/ rather than tests/integration/.
 *
 * Index names come from testenv.indices rather than being spelled out, so the
 * pattern and the indices it is supposed to match cannot drift apart.
 */

const { buildElasticClient, CURSOR_FIELD } = require('../../src/elastic');
const { indices } = require('../testenv');
const {
  adminClient,
  resetAlertsIndex,
  deleteAllTestIndices,
  makeAlert,
  indexAlerts,
  minutesAgo,
} = require('./helpers/esFixtures');

const client = () => buildElasticClient(process.env.ELASTIBOT_TEST_API_KEY);

describe('elastic client (live)', () => {
  beforeAll(async () => {
    await deleteAllTestIndices();
    await resetAlertsIndex();
  });

  describe('getAlertById', () => {
    beforeAll(async () => {
      await indexAlerts([
        makeAlert({
          id: 'live-alert-1',
          timestamp: '2026-03-01T10:00:00.000Z',
          ingested: '2026-03-01T10:00:07.000Z',
          spaceId: 'soc',
          rule: 'Suspicious PowerShell Execution',
          severity: 'critical',
          host: 'WEB-01',
          user: 'jsmith',
        }),
      ]);
    });

    test('maps a real hit onto the alert shape the app works with', async () => {
      const alert = await client().getAlertById('live-alert-1');

      expect(alert).toBeTruthy();
      expect(alert.id).toBe('live-alert-1');
      expect(alert.index).toMatch(new RegExp(`^${indices.testPrefix}`));
      expect(alert.spaceId).toBe('soc');
      expect(alert.ruleName).toBe('Suspicious PowerShell Execution');
    });

    test('the two timestamps come from the two different fields', async () => {
      const alert = await client().getAlertById('live-alert-1');

      // Detection time - what a human means by "when did this fire".
      // Grouping and display use it
      expect(alert.timestamp).toBe('2026-03-01T10:00:00.000Z');
      // Ingest time - what the watcher cursor ranges and sorts on. Seven
      // seconds later here, because that is the gap these two fields exist
      // to represent and mixing them up is a real bug the unit suite can't see
      expect(alert.cursorTimestamp).toBe('2026-03-01T10:00:07.000Z');
      expect(CURSOR_FIELD).toBe('@timestamp');
    });

    test('an id that is not there is null, not an error', async () => {
      await expect(client().getAlertById('no-such-alert')).resolves.toBeNull();
    });

    /*
     * A real alert is not obliged to have every field the mapping allows. An
     * endpoint alert with no user, or a network one with no process, is
     * ordinary - and a hit with those fields absent is something a fixture
     * built by makeAlert() never produces, because makeAlert() fills them all
     * in. So toAlert only ever sees complete documents in the unit suite.
     *
     * Deliberately not asserting on what the absent fields become: that's
     * toAlert's contract and belongs in a unit test. What can only be checked
     * here is that a genuinely sparse document coming back from Elasticsearch
     * doesn't throw on the way through.
     */
    test('a sparse document survives the mapping to an alert', async () => {
      await indexAlerts([
        {
          _id: 'sparse-alert',
          doc: {
            '@timestamp': '2026-03-01T11:00:00.000Z',
            'kibana.alert.@timestamp': '2026-03-01T11:00:00.000Z',
            'kibana.alert.uuid': 'sparse-alert',
            'kibana.alert.rule.name': 'Minimal Rule',
            'kibana.alert.rule.uuid': 'rule-sparse',
            // no space_ids, no host.name, no user.name, no process.name
          },
        },
      ]);

      const alert = await client().getAlertById('sparse-alert');

      expect(alert).toBeTruthy();
      expect(alert.id).toBe('sparse-alert');
      expect(alert.ruleName).toBe('Minimal Rule');
    });
  });

  describe('buildElasticClient credential guard', () => {
    /*
     * The shape of "the analyst never ran /start". Failing at construction is the
     * right call: a client built without a key would otherwise send an
     * unauthenticated request, and on a cluster with anonymous access enabled
     * that succeeds as the anonymous role rather than failing - which is a
     * silent authorization downgrade instead of an error anyone can see.
     */
    test.each([
      ['an empty string', ''],
      ['undefined', undefined],
      ['null', null],
    ])('%s is refused before any request is built', (_label, key) => {
      expect(() => buildElasticClient(key)).toThrow(/API key is required/);
    });

    test('a non-empty key gets as far as a client', () => {
      expect(() => buildElasticClient(Buffer.from('id:secret').toString('base64'))).not.toThrow();
    });
  });

  describe('getAlertsSince', () => {
    beforeAll(async () => {
      await resetAlertsIndex();
      await indexAlerts([
        makeAlert({ id: 'cursor-1', ingested: minutesAgo(50) }),
        makeAlert({ id: 'cursor-2', ingested: minutesAgo(40) }),
        makeAlert({ id: 'cursor-3', ingested: minutesAgo(30) }),
        makeAlert({ id: 'cursor-4', ingested: minutesAgo(20) }),
      ]);
    });

    test('returns everything, oldest first, when there is no cursor yet', async () => {
      const alerts = await client().getAlertsSince(null, 25);
      expect(alerts.map((a) => a.id)).toEqual(['cursor-1', 'cursor-2', 'cursor-3', 'cursor-4']);
    });

    /*
     * Strictly greater than, not greater-or-equal. The watcher stores the
     * timestamp of the last alert it posted, so `gte` would re-post that alert
     * on every single tick, forever
     */
    test('the cursor is exclusive - the alert it points at does not come back', async () => {
      const all = await client().getAlertsSince(null, 25);
      const third = all[2];

      const after = await client().getAlertsSince(third.cursorTimestamp, 25);
      expect(after.map((a) => a.id)).toEqual(['cursor-4']);
      expect(after.map((a) => a.id)).not.toContain(third.id);
    });

    test('size caps the page, and the page is the OLDEST alerts', async () => {
      const alerts = await client().getAlertsSince(null, 2);
      expect(alerts.map((a) => a.id)).toEqual(['cursor-1', 'cursor-2']);
    });

    test('a size larger than the number of alerts is not an error', async () => {
      const alerts = await client().getAlertsSince(null, 500);
      expect(alerts).toHaveLength(4);
    });

    test('a cursor past the newest alert returns nothing', async () => {
      const alerts = await client().getAlertsSince(new Date().toISOString(), 25);
      expect(alerts).toEqual([]);
    });
  });

  /*
   * The watcher does not call getAlertsSince once. It calls it in a loop,
   * feeding the last alert's cursorTimestamp back in until a page comes back
   * empty, and each of the interesting failures is a property of the LOOP
   * rather than of any single call: a page boundary that drops an alert, a
   * cursor that fails to advance and spins forever, an alert delivered twice.
   *
   * A mock can be made to return whatever page sequence you like, which is
   * exactly why a mocked version of this proves nothing. The ordering and the
   * boundaries have to come from Elasticsearch.
   */
  describe('draining the cursor the way the watcher does', () => {
    const TOTAL = 7;
    const PAGE = 3;

    beforeAll(async () => {
      await resetAlertsIndex();
      await indexAlerts(
        Array.from({ length: TOTAL }, (_, i) =>
          makeAlert({ id: `drain-${i}`, ingested: minutesAgo(TOTAL - i) })
        )
      );
    });

    /** Page through to exhaustion, exactly as the watcher tick does */
    const drain = async (pageSize) => {
      const seen = [];
      let cursor = null;

      // Bounded so a cursor that fails to advance fails the test instead of
      // hanging until the 60s timeout with no useful message
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await client().getAlertsSince(cursor, pageSize);
        if (page.length === 0) return seen;
        seen.push(...page.map((a) => a.id));
        cursor = page[page.length - 1].cursorTimestamp;
      }
      throw new Error(`cursor did not advance - drained ${seen.length} and kept going`);
    };

    test('every alert is delivered exactly once across pages', async () => {
      const seen = await drain(PAGE);

      expect(seen).toHaveLength(TOTAL);
      expect(new Set(seen).size).toBe(TOTAL);
      expect(seen).toEqual(Array.from({ length: TOTAL }, (_, i) => `drain-${i}`));
    });

    test('the page size does not change what gets delivered, only how', async () => {
      // 1 forces a page boundary between every single pair of alerts
      await expect(drain(1)).resolves.toEqual(await drain(TOTAL + 5));
    });
  });

  /*
   * Alerts that share a cursor timestamp, split by a page boundary.
   *
   * CONFIRMED BUG, not a hypothesis. Seeding tie-a/tie-b/tie-c at one instant
   * and paging with size 2 delivers ["tie-a", "tie-b", "after"] - tie-c is
   * skipped and never comes back on any later tick.
   *
   * Why it happens: getAlertsSince sorts on @timestamp alone, with no
   * tiebreaker, and filters with `gt`. The page ends on tie-b, the cursor
   * becomes that shared timestamp, and the next call excludes everything at
   * that instant - including the member of the group that was never returned.
   *
   * Why it matters in production: a rule firing on a batch writes several
   * alerts with the same @timestamp, and Elasticsearch stores milliseconds, so
   * a bulk of them landing on one value is routine rather than rare. Whenever
   * WATCH_FETCH_SIZE cuts such a group, the remainder is dropped silently -
   * no error, no retry, nothing in the tick summary.
   *
   * Leaving this red until the cursor gets a tiebreaker.
   */
  describe('alerts sharing one cursor timestamp', () => {
    const SAME = '2026-03-01T12:00:00.000Z';

    beforeAll(async () => {
      await resetAlertsIndex();
      await indexAlerts([
        makeAlert({ id: 'tie-a', ingested: SAME }),
        makeAlert({ id: 'tie-b', ingested: SAME }),
        makeAlert({ id: 'tie-c', ingested: SAME }),
        makeAlert({ id: 'after', ingested: '2026-03-01T12:00:05.000Z' }),
      ]);
    });

    test('all four come back when they fit in one page', async () => {
      const alerts = await client().getAlertsSince(null, 25);
      expect(alerts).toHaveLength(4);
    });

    test('none are lost when a page boundary falls inside the tied group', async () => {
      const first = await client().getAlertsSince(null, 2);
      expect(first).toHaveLength(2);

      const rest = await client().getAlertsSince(first[1].cursorTimestamp, 25);

      const delivered = [...first, ...rest].map((a) => a.id);
      expect(delivered).toHaveLength(4);
      expect(new Set(delivered).size).toBe(4);
    });
  });

  /*
   * ALERTS_INDEX is a pattern, and in a real deployment it spans the rollover
   * indices behind .alerts-security.alerts-*. A query that works against one
   * index and not across several is a bug that only appears in production,
   * some weeks after go-live
   */
  describe('across a rolled-over index pattern', () => {
    const first = indices.backingIndex(1);
    const second = indices.backingIndex(2);

    beforeAll(async () => {
      await deleteAllTestIndices();
      await resetAlertsIndex(first);
      await resetAlertsIndex(second);
      await indexAlerts([makeAlert({ id: 'old-index-alert', ingested: minutesAgo(60) })], first);
      await indexAlerts([makeAlert({ id: 'new-index-alert', ingested: minutesAgo(10) })], second);
    });

    afterAll(async () => {
      await deleteAllTestIndices();
      await resetAlertsIndex();
    });

    test('an alert is found whichever backing index it landed in', async () => {
      await expect(client().getAlertById('old-index-alert')).resolves.toMatchObject({
        index: first,
      });
      await expect(client().getAlertById('new-index-alert')).resolves.toMatchObject({
        index: second,
      });
    });

    test('the cursor orders across indices, not within one', async () => {
      const alerts = await client().getAlertsSince(null, 25);
      expect(alerts.map((a) => a.id)).toEqual(['old-index-alert', 'new-index-alert']);
    });
  });

  /*
   * The state every deployment is in for its first few minutes: the pattern is
   * configured and nothing matches it yet. Elasticsearch's default for a
   * search against a wildcard that resolves to no indices is an empty result,
   * but the default for several nearby settings is a 404, and which one you
   * get depends on flags the client sets. If it 404s, the watcher's first tick
   * throws on a brand new install and the operator's first experience of the
   * bot is a stack trace.
   */
  describe('before any alerts index exists', () => {
    beforeAll(async () => {
      await deleteAllTestIndices();
    });

    afterAll(async () => {
      await resetAlertsIndex();
    });

    test('the watcher query is empty rather than an error', async () => {
      await expect(client().getAlertsSince(null, 25)).resolves.toEqual([]);
    });

    test('looking an alert up is null rather than an error', async () => {
      await expect(client().getAlertById('anything')).resolves.toBeNull();
    });
  });

  /*
   * The 401 path is the one behind "your key was revoked, re-run /start". The
   * unit suite asserts on a hand-built 401; this asserts that a revoked key
   * really does produce one, which is a claim about Elasticsearch and not
   * about us
   */
  describe('authentication', () => {
    test('a revoked API key gives a 401, which is what /start keys off', async () => {
      const es = adminClient();
      const { data: created } = await es.post('/_security/api_key', {
        name: `elastibot-integration-doomed-${Date.now()}`,
      });

      // It works first, or the assertion below proves nothing
      await expect(
        buildElasticClient(created.encoded).getAlertById('anything')
      ).resolves.toBeNull();

      await es.delete('/_security/api_key', { data: { ids: [created.id] } });

      // Elastic caches key validity briefly; retry rather than sleep-and-hope
      let status = null;
      for (let i = 0; i < 10 && status !== 401; i += 1) {
        try {
          await buildElasticClient(created.encoded).getAlertById('anything');
        } catch (err) {
          status = err.response?.status ?? null;
        }
        if (status !== 401) await new Promise((r) => setTimeout(r, 500));
      }

      expect(status).toBe(401);
    });

    test('a malformed API key is rejected outright', async () => {
      const bogus = buildElasticClient(Buffer.from('nope:nope').toString('base64'));
      await expect(bogus.getAlertById('anything')).rejects.toMatchObject({
        response: { status: 401 },
      });
    });

    /*
     * The empty-key case is NOT here on purpose. buildElasticClient throws
     * before it builds anything, so nothing reaches the cluster and the
     * assertion passes against a mock - which puts it in tests/ by this file's
     * own rule. See tests/elasticClient.test.js.
     */
  });
});