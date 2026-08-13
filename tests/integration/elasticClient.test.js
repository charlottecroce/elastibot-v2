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
 */

const { buildElasticClient, CURSOR_FIELD } = require('../../src/elastic');
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
      expect(alert.index).toMatch(/^test-alerts-security-/);
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

    test('a cursor past the newest alert returns nothing', async () => {
      const alerts = await client().getAlertsSince(new Date().toISOString(), 25);
      expect(alerts).toEqual([]);
    });
  });

  /*
   * ALERTS_INDEX is a pattern, and in a real deployment it spans the rollover
   * indices behind .alerts-security.alerts-*. A query that works against one
   * index and not across several is a bug that only appears in production,
   * some weeks after go-live
   */
  describe('across a rolled-over index pattern', () => {
    beforeAll(async () => {
      await deleteAllTestIndices();
      await resetAlertsIndex('test-alerts-security-000001');
      await resetAlertsIndex('test-alerts-security-000002');
      await indexAlerts(
        [makeAlert({ id: 'old-index-alert', ingested: minutesAgo(60) })],
        'test-alerts-security-000001'
      );
      await indexAlerts(
        [makeAlert({ id: 'new-index-alert', ingested: minutesAgo(10) })],
        'test-alerts-security-000002'
      );
    });

    afterAll(async () => {
      await deleteAllTestIndices();
      await resetAlertsIndex();
    });

    test('an alert is found whichever backing index it landed in', async () => {
      await expect(client().getAlertById('old-index-alert')).resolves.toMatchObject({
        index: 'test-alerts-security-000001',
      });
      await expect(client().getAlertById('new-index-alert')).resolves.toMatchObject({
        index: 'test-alerts-security-000002',
      });
    });

    test('the cursor orders across indices, not within one', async () => {
      const alerts = await client().getAlertsSince(null, 25);
      expect(alerts.map((a) => a.id)).toEqual(['old-index-alert', 'new-index-alert']);
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
  });
});