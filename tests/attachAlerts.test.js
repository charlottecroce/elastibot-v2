'use strict';

const { attachInRuleBatches, groupByRule, ruleKey } = require('../src/services/attachAlerts');
const config = require('../config');

function alert(id, over = {}) {
  return {
    id,
    index: '.internal.alerts-security.alerts-default-000001',
    ruleId: 'rule-a',
    ruleName: 'Malware Detected',
    owner: 'securitySolution',
    ...over,
  };
}

const httpError = (status, body) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: body },
  });

const fakeClient = (attachAlert = jest.fn().mockResolvedValue({})) => ({ attachAlert });

describe('groupByRule', () => {
  test('groups on ruleId and preserves first-seen order', () => {
    const groups = groupByRule([
      alert('1', { ruleId: 'a' }),
      alert('2', { ruleId: 'b' }),
      alert('3', { ruleId: 'a' }),
    ]);

    expect([...groups.keys()]).toEqual(['a', 'b']);
    expect(groups.get('a').map((a) => a.id)).toEqual(['1', '3']);
  });

  test('falls back to rule name, then to a literal, so an alert is never dropped', () => {
    expect(ruleKey({ ruleName: 'Only A Name' })).toBe('Only A Name');
    expect(ruleKey({})).toBe('unknown');
    // The important property: no alert silently vanishes from the batching
    expect(groupByRule([alert('1', { ruleId: null, ruleName: null })]).size).toBe(1);
  });
});

describe('attachInRuleBatches', () => {
  test('posts one request per rule with the whole batch of ids', async () => {
    const client = fakeClient();
    const alerts = [
      alert('1', { ruleId: 'a', ruleName: 'Rule A' }),
      alert('2', { ruleId: 'a', ruleName: 'Rule A' }),
      alert('3', { ruleId: 'b', ruleName: 'Rule B' }),
    ];

    const res = await attachInRuleBatches(client, { spaceId: 'soc', caseId: 'case-1', alerts });

    expect(client.attachAlert).toHaveBeenCalledTimes(2);
    const [spaceId, caseId, first] = client.attachAlert.mock.calls[0];
    expect(spaceId).toBe('soc');
    expect(caseId).toBe('case-1');
    expect(first.alertId).toEqual(['1', '2']);
    expect(first.rule).toEqual({ id: 'a', name: 'Rule A' });
    expect(res.attachedIds).toEqual(['1', '2', '3']);
    expect(res.warning).toBeNull();
  });

  test('an explicit owner overrides the per-alert one', async () => {
    // Case creation picks a single owner for the whole case; attaching to an
    // existing case takes each alert's own
    const client = fakeClient();
    await attachInRuleBatches(client, {
      spaceId: 'soc',
      caseId: 'case-1',
      alerts: [alert('1', { owner: 'observability' })],
      owner: 'securitySolution',
    });

    expect(client.attachAlert.mock.calls[0][2].owner).toBe('securitySolution');
  });

  test('an alert with no owner falls back to the configured default', async () => {
    const client = fakeClient();
    await attachInRuleBatches(client, {
      spaceId: 'soc',
      caseId: 'case-1',
      alerts: [alert('1', { owner: null })],
    });

    expect(client.attachAlert.mock.calls[0][2].owner).toBe(config.elastic.defaultOwner);
  });

  test('one failed batch does not stop the others, and is named in the warning', async () => {
    // A case that got 9 of 10 alerts is still a useful case
    const client = fakeClient(
      jest
        .fn()
        .mockRejectedValueOnce(httpError(400, { message: 'alert already attached' }))
        .mockResolvedValueOnce({})
    );

    const res = await attachInRuleBatches(client, {
      spaceId: 'soc',
      caseId: 'case-1',
      alerts: [
        alert('1', { ruleId: 'a', ruleName: 'Rule A' }),
        alert('2', { ruleId: 'b', ruleName: 'Rule B' }),
      ],
    });

    expect(res.attachedIds).toEqual(['2']); // the surviving batch still landed
    expect(res.failures).toHaveLength(1);
    expect(res.warning).toContain('Rule A');
    expect(res.warning).toContain('already attached'); // the Elastic reason survives
  });

  test('a total failure reports every batch and attaches nothing', async () => {
    // The caller decides whether this is fatal - creating a case treats it as
    // fatal, adding to an existing one does not
    const client = fakeClient(jest.fn().mockRejectedValue(httpError(503, {})));

    const res = await attachInRuleBatches(client, {
      spaceId: 'soc',
      caseId: 'case-1',
      alerts: [alert('1', { ruleId: 'a' }), alert('2', { ruleId: 'b' })],
    });

    expect(res.attachedIds).toEqual([]);
    expect(res.failures).toHaveLength(2);
  });

  test('an empty alert list makes no requests', async () => {
    const client = fakeClient();
    const res = await attachInRuleBatches(client, {
      spaceId: 'soc',
      caseId: 'case-1',
      alerts: [],
    });

    expect(client.attachAlert).not.toHaveBeenCalled();
    expect(res).toEqual({ attachedIds: [], failures: [], warning: null });
  });
});