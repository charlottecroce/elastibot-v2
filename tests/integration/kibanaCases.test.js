'use strict';

/*
 * Use `--no-kibana` (or `npm run stack:up:no-kibana`) for
 * the lighter Elasticsearch-only stack if you want to skip this file.
 *
 * What it's for: every POST here goes through Kibana's own validation.
 */

const { buildElasticClient } = require('../../src/elastic');
const { createCaseForAlert } = require('../../src/services/caseService');
const { resetAlertsIndex, makeAlert, indexAlerts } = require('./helpers/esFixtures');
const env = require('./env');

// Not describe.skip at module scope: hasKibana() is only meaningful after
// globalSetup has probed, and this is evaluated late enough to see it
const withKibana = env.hasKibana() ? describe : describe.skip;

const apiKey = () => process.env.ELASTIBOT_TEST_API_KEY;
const client = () => buildElasticClient(apiKey());

withKibana('kibana cases and spaces (live)', () => {
  beforeAll(async () => {
    await resetAlertsIndex();
    await indexAlerts([
      makeAlert({
        id: 'case-alert-1',
        rule: 'Suspicious PowerShell Execution',
        ruleUuid: 'rule-uuid-live',
        consumer: 'siem',
        severity: 'high',
        host: 'WEB-01',
        user: 'jsmith',
      }),
    ]);
  });

  describe('spaces', () => {
    test('the default space resolves to its display name', async () => {
      await expect(client().getSpaceName('default')).resolves.toBe('Default');
    });

    /*
     * spaceService owns the fallback for this, and it can only own it if the
     * client really does reject. A client that swallowed the 404 and returned
     * the id would make the fallback dead code that looks alive
     */
    test('a space that does not exist rejects rather than inventing a name', async () => {
      await expect(client().getSpaceName('no-such-space')).rejects.toMatchObject({
        response: { status: 404 },
      });
    });
  });

  describe('the case lifecycle', () => {
    let caseId;

    test('a case can be created and read back', async () => {
      const created = await client().createCase('default', {
        title: 'Elastibot integration test case',
        description: 'Created by tests/integration/kibanaCases.test.js',
        tags: ['elastibot', 'integration-test'],
        owner: 'cases',
        connector: { id: 'none', name: 'none', type: '.none', fields: null },
        settings: { syncAlerts: false },
      });

      expect(created.id).toEqual(expect.any(String));
      expect(created.title).toBe('Elastibot integration test case');
      caseId = created.id;

      const fetched = await client().getCase('default', caseId);
      // getCase exists so /add_alert can check status before attaching
      expect(fetched.status).toBe('open');
    });

    test('an alert can be attached to it', async () => {
      const updated = await client().attachAlert('default', caseId, {
        type: 'alert',
        alertId: ['case-alert-1'],
        index: [env.writeIndex],
        rule: { id: 'rule-uuid-live', name: 'Suspicious PowerShell Execution' },
        owner: 'cases',
      });

      expect(updated).toBeTruthy();
    });

    test('it shows up in the recent cases the watcher polls', async () => {
      const cases = await client().findRecentCases('default', 25);
      expect(cases.map((c) => c.id)).toContain(caseId);
    });
  });

  /*
   * The whole /case path, end to end, against real Elastic: look the alert up,
   * derive the owner from its consumer, build the title, create the case in
   * the alert's own space, attach the alert, build the link.
   *
   * Note the link is built from KIBANA_PUBLIC_URL, not from the URL the
   * request went to. Those are the same in this test stack, so this asserts
   * the shape rather than the distinction - the distinction has a unit test
   */
  describe('createCaseForAlert', () => {
    test('turns a real alert into a real case', async () => {
      const result = await createCaseForAlert(apiKey(), 'case-alert-1');

      expect(result.caseId).toEqual(expect.any(String));
      expect(result.alertCount).toBe(1);
      expect(result.attachedCount).toBe(1);
      expect(result.warning).toBeNull();
      expect(result.title).toContain('Suspicious PowerShell Execution');
      expect(result.link).toContain(result.caseId);

      // And it really is there, not just a well-shaped return value
      const fetched = await buildElasticClient(apiKey()).getCase('default', result.caseId);
      expect(fetched.id).toBe(result.caseId);
      expect(fetched.totalComment + (fetched.totalAlerts ?? 0)).toBeGreaterThan(0);
    });

    test('an alert id that is not in the cluster is a user-facing error', async () => {
      await expect(createCaseForAlert(apiKey(), 'definitely-not-an-alert')).rejects.toThrow(
        /No alert found/
      );
    });
  });
});