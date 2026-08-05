'use strict';

jest.mock('../src/elastic', () => ({ createElasticClient: jest.fn() }));

const { createElasticClient } = require('../src/elastic');
const {
  createCaseForAlert,
  createCaseForGroup,
  addAlertToCase,
} = require('../src/services/caseService');

const { UserFacingError } = require('../src/util/errors');

/*
 * The Elastic client is faked - these tests are about what Elastibot
 * decides (title, owner, how alerts are batched onto the case, what happens when an attach fails), not about HTTP
 */

const T0 = '2026-07-30T12:00:00.000Z';

function alert(id, over = {}) {
  return {
    id,
    index: '.internal.alerts-security.alerts-default-000001',
    spaceId: 'default',
    ruleName: 'Malware Detected',
    ruleId: 'rule-uuid-a',
    severity: 'high',
    timestamp: T0,
    owner: 'securitySolution',
    userName: 'jsmith',
    hostName: 'web-01',
    ...over,
  };
}

/** A client where every method is a jest.fn with a sane default */
function fakeClient(over = {}) {
  const client = {
    getAlertById: jest.fn().mockResolvedValue(alert('alert-1')),
    getRelatedAlerts: jest.fn().mockResolvedValue([alert('alert-1')]),
    getSpaceName: jest.fn().mockResolvedValue('Security Operations'),
    createCase: jest.fn().mockResolvedValue({ id: 'case-1' }),
    getCase: jest.fn().mockResolvedValue({ status: 'open' }),
    attachAlert: jest.fn().mockResolvedValue({}),
    setAlertsWorkflowStatus: jest.fn().mockResolvedValue({}),
    ...over,
  };
  createElasticClient.mockReturnValue(client);
  return client;
}

/** axios-shaped rejection */
function httpError(status, body) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: body },
  });
}

describe('createCaseForAlert', () => {
  test('creates the case in the alert space and attaches the alert', async () => {
    const client = fakeClient();
    const result = await createCaseForAlert('api-key', 'alert-1');

    expect(client.createCase).toHaveBeenCalledTimes(1);
    const [spaceId, body] = client.createCase.mock.calls[0];
    expect(spaceId).toBe('default');
    expect(body.owner).toBe('securitySolution');
    expect(body.settings).toEqual({ syncAlerts: true });
    expect(body.tags).toContain('elastibot');
    expect(body.description).toContain('alert-1');
    expect(body.description).not.toContain('grouped by');

    expect(client.attachAlert).toHaveBeenCalledTimes(1);
    const attachment = client.attachAlert.mock.calls[0][2];
    expect(attachment).toMatchObject({
      type: 'alert',
      alertId: ['alert-1'],
      rule: { id: 'rule-uuid-a', name: 'Malware Detected' },
    });

    expect(result).toMatchObject({
      caseId: 'case-1',
      alertCount: 1,
      attachedCount: 1,
      spaceName: 'Security Operations',
      warning: null,
    });
    expect(result.title).toMatch(/^SO-\d{6}-Malware Detected$/);
    expect(result.link).toBe('https://kibana.example.com/app/security/cases/case-1');
  });

  test('an unknown alert id is a friendly error, not a crash', async () => {
    fakeClient({ getAlertById: jest.fn().mockResolvedValue(null) });
    await expect(createCaseForAlert('api-key', 'nope')).rejects.toThrow(UserFacingError);
    await expect(createCaseForAlert('api-key', 'nope')).rejects.toThrow(/No alert found/);
  });

  test('a 403 from Elastic tells the analyst to re-run /start', async () => {
    fakeClient({ getAlertById: jest.fn().mockRejectedValue(httpError(403, {})) });
    await expect(createCaseForAlert('api-key', 'alert-1')).rejects.toThrow(/Re-run `\/start`/);
  });

  test('a failed case creation surfaces the Elastic reason', async () => {
    fakeClient({
      createCase: jest.fn().mockRejectedValue(httpError(400, { message: 'bad connector' })),
    });
    await expect(createCaseForAlert('api-key', 'alert-1')).rejects.toThrow(/bad connector/);
  });
});

describe('createCaseForGroup', () => {
  test('attaches a burst in one batch per rule and reports the counts', async () => {
    const client = fakeClient({
      getRelatedAlerts: jest.fn().mockResolvedValue([
        alert('a1', { ruleName: 'Malware Detected', ruleId: 'rule-a' }),
        alert('a2', { ruleName: 'Malware Detected', ruleId: 'rule-a' }),
        alert('a3', { ruleName: 'Beaconing', ruleId: 'rule-b' }),
      ]),
    });

    const result = await createCaseForGroup('api-key', {
      spaceId: 'default',
      userName: 'jsmith',
      hostName: 'web-01',
      from: T0,
      to: T0,
    });

    // one comment per rule, carrying every alert id for that rule
    expect(client.attachAlert).toHaveBeenCalledTimes(2);
    const batches = client.attachAlert.mock.calls.map((c) => c[2]);
    expect(batches[0].alertId).toEqual(['a1', 'a2']);
    expect(batches[1].alertId).toEqual(['a3']);

    expect(result.alertCount).toBe(3);
    expect(result.attachedCount).toBe(3);
    expect(result.ruleCounts).toEqual({ 'Malware Detected': 2, Beaconing: 1 });
    expect(result.ruleName).toBe('Malware Detected'); // most common rule titles the case
    expect(result.warning).toBeNull();
  });

  test('the grouped description mentions grouping and the time range', async () => {
    const client = fakeClient({
      getRelatedAlerts: jest.fn().mockResolvedValue([
        alert('a1', { timestamp: '2026-07-30T12:00:00.000Z' }),
        alert('a2', { timestamp: '2026-07-30T12:30:00.000Z' }),
      ]),
    });
    await createCaseForGroup('api-key', { spaceId: 'default' });

    const { description } = client.createCase.mock.calls[0][1];
    expect(description).toContain('2 alerts grouped by user + host');
    expect(description).toContain('2026-07-30T12:00:00.000Z');
    expect(description).toContain('2026-07-30T12:30:00.000Z');
  });

  test('duplicate alert ids are only attached once', async () => {
    const client = fakeClient({
      getRelatedAlerts: jest.fn().mockResolvedValue([alert('a1'), alert('a1'), alert('a2')]),
    });
    const result = await createCaseForGroup('api-key', { spaceId: 'default' });
    expect(result.alertCount).toBe(2);
    expect(client.attachAlert.mock.calls[0][2].alertId).toEqual(['a1', 'a2']);
  });

  test('a partial attach failure still returns the case, with a warning', async () => {
    const client = fakeClient({
      getRelatedAlerts: jest.fn().mockResolvedValue([
        alert('a1', { ruleName: 'Malware Detected', ruleId: 'rule-a' }),
        alert('a2', { ruleName: 'Beaconing', ruleId: 'rule-b' }),
      ]),
    });
    client.attachAlert
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(httpError(500, { message: 'index closed' }));

    const result = await createCaseForGroup('api-key', { spaceId: 'default' });
    expect(result.caseId).toBe('case-1');
    expect(result.attachedCount).toBe(1);
    expect(result.warning).toMatch(/Beaconing ×1/);
    expect(result.warning).toMatch(/index closed/);
  });

  test('if nothing attaches at all it throws, but names the orphaned case', async () => {
    const client = fakeClient();
    client.attachAlert.mockRejectedValue(httpError(500, { message: 'nope' }));
    await expect(createCaseForGroup('api-key', { spaceId: 'default' })).rejects.toThrow(
      /case-1/
    );
  });

  test('a group whose alerts have aged out is a friendly error', async () => {
    fakeClient({ getRelatedAlerts: jest.fn().mockResolvedValue([]) });
    await expect(createCaseForGroup('api-key', { spaceId: 'default' })).rejects.toThrow(
      /aged out/
    );
  });

  test('a non-default space is carried into the case link', async () => {
    fakeClient({
      getRelatedAlerts: jest.fn().mockResolvedValue([alert('a1', { spaceId: 'soc' })]),
    });
    const result = await createCaseForGroup('api-key', { spaceId: 'soc' });
    expect(result.link).toContain('/s/soc/app/security/cases/case-1');
  });
});

describe('addAlertToCase', () => {
  test('attaches to the case and leaves an open case alone', async () => {
    const client = fakeClient({ getCase: jest.fn().mockResolvedValue({ status: 'open' }) });
    const result = await addAlertToCase('api-key', 'case-1', 'alert-1');

    expect(client.attachAlert).toHaveBeenCalledWith('default', 'case-1', {
      type: 'alert',
      alertId: 'alert-1',
      index: '.internal.alerts-security.alerts-default-000001',
      rule: { id: 'rule-uuid-a', name: 'Malware Detected' },
      owner: 'securitySolution',
    });
    // an open case needs no catch-up, Kibana's own syncing has it from here
    expect(client.setAlertsWorkflowStatus).not.toHaveBeenCalled();
    expect(result).toMatchObject({ caseId: 'case-1', alertId: 'alert-1' });
  });

  test('an in-progress case pulls the new alert up to acknowledged', async () => {
    const client = fakeClient({ getCase: jest.fn().mockResolvedValue({ status: 'in-progress' }) });
    await addAlertToCase('api-key', 'case-1', 'alert-1');
    expect(client.setAlertsWorkflowStatus).toHaveBeenCalledWith('default', ['alert-1'], 'acknowledged');
  });

  test('a closed case closes the new alert too', async () => {
    const client = fakeClient({ getCase: jest.fn().mockResolvedValue({ status: 'closed' }) });
    await addAlertToCase('api-key', 'case-1', 'alert-1');
    expect(client.setAlertsWorkflowStatus).toHaveBeenCalledWith('default', ['alert-1'], 'closed');
  });

  test('a failed status sync does not fail the whole command', async () => {
    const client = fakeClient({
      getCase: jest.fn().mockResolvedValue({ status: 'closed' }),
      setAlertsWorkflowStatus: jest.fn().mockRejectedValue(httpError(500, {})),
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(addAlertToCase('api-key', 'case-1', 'alert-1')).resolves.toMatchObject({
      caseId: 'case-1',
    });
    expect(client.attachAlert).toHaveBeenCalled();
  });

  test('a missing case points at the creation message', async () => {
    fakeClient({ getCase: jest.fn().mockRejectedValue(httpError(404, {})) });
    await expect(addAlertToCase('api-key', 'nope', 'alert-1')).rejects.toThrow(
      /Could not find case/
    );
  });

  test('a missing alert is a friendly error', async () => {
    fakeClient({ getAlertById: jest.fn().mockResolvedValue(null) });
    await expect(addAlertToCase('api-key', 'case-1', 'nope')).rejects.toThrow(/No alert found/);
  });

  test('a failed attach surfaces the Elastic reason', async () => {
    const client = fakeClient();
    client.attachAlert.mockRejectedValue(httpError(400, { message: 'alert already attached' }));
    await expect(addAlertToCase('api-key', 'case-1', 'alert-1')).rejects.toThrow(
      /alert already attached/
    );
  });
});