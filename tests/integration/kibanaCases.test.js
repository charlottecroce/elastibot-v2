'use strict';

/*
 * Use `--no-kibana` (or `npm run stack:up:no-kibana`) for
 * the lighter Elasticsearch-only stack if you want to skip this file.
 *
 * What it's for: every POST here goes through Kibana's own validation.
 */

const axios = require('axios');
const { buildElasticClient } = require('../../src/elastic');
const { createCaseForAlert } = require('../../src/services/caseService');
const { resetAlertsIndex, makeAlert, indexAlerts } = require('./helpers/esFixtures');
const { stack, indices } = require('../testenv');

// Not describe.skip at module scope: hasKibana() is only meaningful after
// globalSetup has probed, and this is evaluated late enough to see it
const withKibana = stack.hasKibana() ? describe : describe.skip;

const apiKey = () => process.env.ELASTIBOT_TEST_API_KEY;
const client = () => buildElasticClient(apiKey());

/*
 * Cases are Kibana saved objects. globalSetup wipes the alert indices between
 * runs, and globalTeardown revokes the API key, but neither touches saved
 * objects - so without this every run left its cases behind in a stack that is
 * reused on purpose, and findRecentCases() was paging through months of them.
 *
 * Admin credentials rather than the suite's API key: Kibana APIs authenticate
 * with the basic-auth user, and cleanup should not depend on the key that
 * globalTeardown may already have revoked.
 */
const created = [];

const kibanaAdmin = () =>
  axios.create({
    baseURL: stack.kibanaUrl,
    auth: { username: stack.username, password: stack.password },
    headers: { 'kbn-xsrf': 'true' },
    timeout: 20000,
    validateStatus: () => true,
  });

/** Remember a case id so afterAll deletes it. Returns the id, so it chains */
const track = (id) => {
  if (id) created.push(id);
  return id;
};

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

  // Best effort, and deliberately not asserted on: a cleanup failure is a
  // tidiness problem, and failing an otherwise green run over it teaches
  // people to ignore the failure
  afterAll(async () => {
    if (created.length === 0) return;
    try {
      await kibanaAdmin().delete('/api/cases', {
        params: { ids: JSON.stringify(created) },
      });
    } catch {
      /* ignore */
    }
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
      const createdCase = await client().createCase('default', {
        title: 'Elastibot integration test case',
        description: 'Created by tests/integration/kibanaCases.test.js',
        tags: ['elastibot', 'integration-test'],
        owner: 'cases',
        connector: { id: 'none', name: 'none', type: '.none', fields: null },
        settings: { syncAlerts: false },
      });

      expect(createdCase.id).toEqual(expect.any(String));
      expect(createdCase.title).toBe('Elastibot integration test case');
      caseId = track(createdCase.id);

      const fetched = await client().getCase('default', caseId);
      // getCase exists so /add_alert can check status before attaching
      expect(fetched.status).toBe('open');
    });

    test('an alert can be attached to it', async () => {
      const updated = await client().attachAlert('default', caseId, {
        type: 'alert',
        alertId: ['case-alert-1'],
        index: [indices.writeIndex],
        rule: { id: 'rule-uuid-live', name: 'Suspicious PowerShell Execution' },
        owner: 'cases',
      });

      expect(updated).toBeTruthy();
    });

    test('it shows up in the recent cases the watcher polls', async () => {
      const cases = await client().findRecentCases('default', 25);
      expect(cases.map((c) => c.id)).toContain(caseId);
    });

    /*
     * A case id that is well-formed but gone. /add_alert looks a case up before
     * attaching, and the difference between a 404 it can report and an
     * exception it can't is the difference between "that case no longer exists"
     * and a stack trace in the analyst's DM.
     */
    test('a case id that is not there rejects with a 404', async () => {
      await expect(client().getCase('default', 'no-such-case-id')).rejects.toMatchObject({
        response: { status: 404 },
      });
    });
  });

  /*
   * The case watcher pages findRecentCases and posts anything newer than its
   * cursor. That is only correct if Kibana returns cases newest-first - if the
   * order is by creation ascending, or unspecified, the watcher posts the
   * oldest 25 cases forever and never reaches the new ones.
   *
   * Nothing in the app can assert this. It is a claim about Kibana's default
   * sort, and it changes between versions.
   */
  describe('findRecentCases ordering', () => {
    const newCase = (title) =>
      client().createCase('default', {
        title,
        description: 'ordering probe',
        tags: ['elastibot', 'integration-test'],
        owner: 'cases',
        connector: { id: 'none', name: 'none', type: '.none', fields: null },
        settings: { syncAlerts: false },
      });

    let older;
    let newer;

    beforeAll(async () => {
      older = track((await newCase(`ordering-older-${Date.now()}`)).id);
      // Distinct createdAt: Kibana stores milliseconds and two sequential
      // round trips are comfortably further apart than that, but not
      // guaranteed to be, so make it explicit
      await new Promise((r) => setTimeout(r, 50));
      newer = track((await newCase(`ordering-newer-${Date.now()}`)).id);
    });

    test('the most recently created case comes back first', async () => {
      const cases = await client().findRecentCases('default', 25);
      const ids = cases.map((c) => c.id);

      expect(ids).toContain(older);
      expect(ids).toContain(newer);
      expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
    });

    test('the page size is respected, and the page is the NEWEST cases', async () => {
      const one = await client().findRecentCases('default', 1);

      expect(one).toHaveLength(1);
      expect(one[0].id).toBe(newer);
    });
  });

  /*
   * Kibana validating the bodies we send it is half the point of this file.
   * Each of these is a body the unit suite's mock would accept without comment.
   */
  describe('what Kibana rejects', () => {
    const body = (over = {}) => ({
      title: `validation probe ${Date.now()}`,
      description: 'validation probe',
      tags: ['elastibot', 'integration-test'],
      owner: 'cases',
      connector: { id: 'none', name: 'none', type: '.none', fields: null },
      settings: { syncAlerts: false },
      ...over,
    });

    /*
     * 403, not 400. An owner in Cases is not a schema enum - it maps to a
     * feature privilege, so an owner nobody has rights to is indistinguishable
     * from an owner that doesn't exist, and both come back forbidden.
     *
     * Worth knowing where the error message is written: "you don't have
     * permission" is wrong for a typo'd DEFAULT_CASE_OWNER, and "no such owner"
     * is wrong for an analyst whose key genuinely lacks the privilege. The
     * status alone cannot tell them apart.
     */
    test('an owner Cases does not know is refused, not left in limbo', async () => {
      await expect(
        client().createCase('default', body({ owner: 'not-a-real-owner' }))
      ).rejects.toMatchObject({ response: { status: 403 } });
    });

    /*
     * The one that matters for the /case path: DEFAULT_CASE_OWNER, and the
     * owner derived from an alert's consumer, both end up here. A value that
     * looks plausible and isn't means every case creation fails in production
     * and none of them fail in test.
     */
    test('the configured default owner is one Cases accepts', async () => {
      const { defaultOwner } = require('../../config').elastic;

      const ok = await client().createCase('default', body({ owner: defaultOwner }));
      expect(track(ok.id)).toEqual(expect.any(String));
    });

    test('a case in a space that does not exist is rejected', async () => {
      await expect(client().createCase('no-such-space', body())).rejects.toMatchObject({
        response: { status: expect.any(Number) },
      });
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
      track(result.caseId);

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

    /*
     * The alert is attached, not just referenced in the description. Kibana
     * counts alert attachments separately from comments, and a case that looks
     * right in Slack but has no alert on it is the failure an analyst finds
     * three days later while writing up the incident.
     */
    test('the alert is attached as an alert, not as prose', async () => {
      const result = await createCaseForAlert(apiKey(), 'case-alert-1');
      track(result.caseId);

      const fetched = await client().getCase('default', result.caseId);
      expect(fetched.totalAlerts ?? 0).toBeGreaterThan(0);
    });

    /*
     * The alert's own space, not the default one. Every alert seeded here is in
     * `default`, so this asserts the plumbing rather than the distinction -
     * a non-default space would need a Kibana space to exist, and nothing in
     * this stack creates one.
     */
    test('the case lands in the space the alert belongs to', async () => {
      const result = await createCaseForAlert(apiKey(), 'case-alert-1');
      track(result.caseId);

      await expect(client().getCase('default', result.caseId)).resolves.toMatchObject({
        id: result.caseId,
      });
    });

    test('an alert id that is not in the cluster is a user-facing error', async () => {
      await expect(createCaseForAlert(apiKey(), 'definitely-not-an-alert')).rejects.toThrow(
        /No alert found/
      );
    });
  });
});