'use strict';

const {
  diffRule,
  buildPatch,
  buildCreateBody,
  contentHash,
  PRESERVED_FIELDS,
} = require('../src/sigma/ruleDiff');

/*
 * This file is the feature's safety net. /sigma update writes to live detection
 * rules, and the one thing it must never do is take an analyst's tuning with it
 * - the index patterns they narrowed, the exceptions they built after a week of
 * false positives, the schedule they slowed down. Everything below is either
 * that guarantee or the noise suppression that makes the command usable
 */

/** A stack rule with local tuning on it */
const stackRule = (over = {}) => ({
  id: 'kibana-uuid',
  rule_id: '67f113fa-e23d-4271-befa-30113b3e08b1',
  name: 'Suspicious PowerShell',
  description: 'Old description',
  query: 'process.name:powershell.exe',
  language: 'lucene',
  severity: 'medium',
  risk_score: 47,
  tags: ['team-tuned', 'attack.execution'],
  references: ['https://example.com/a'],
  index: ['logs-endpoint.custom-*'],
  exceptions_list: [{ id: 'exception-1', list_id: 'l1', type: 'detection', namespace_type: 'single' }],
  investigation_fields: { field_names: ['user.name'] },
  interval: '30m',
  from: 'now-45m',
  enabled: true,
  immutable: false,
  ...over,
});

/** The same rule as Sigma has it */
const sigmaRule = (over = {}) => ({
  rule_id: '67f113fa-e23d-4271-befa-30113b3e08b1',
  name: 'Suspicious PowerShell Execution',
  description: 'New description',
  query: 'process.name:powershell.exe and process.args:*-enc*',
  language: 'lucene',
  severity: 'high',
  risk_score: 73,
  tags: ['attack.execution', 'attack.t1059.001'],
  references: ['https://example.com/a'],
  index: ['logs-*'],
  interval: '5m',
  ...over,
});

describe('what a sigma update is allowed to touch', () => {
  test('a patch carries the detection fields', () => {
    const patch = buildPatch(stackRule(), sigmaRule());

    expect(patch.rule_id).toBe('67f113fa-e23d-4271-befa-30113b3e08b1');
    expect(patch.name).toBe('Suspicious PowerShell Execution');
    expect(patch.severity).toBe('high');
    expect(patch.risk_score).toBe(73);
    expect(patch.query).toContain('-enc');
  });

  test('a patch carries none of the fields the analyst owns', () => {
    // The list is the contract. If a field is added to SYNCED_FIELDS that also
    // appears here, this fails - which is the point
    const patch = buildPatch(stackRule(), sigmaRule());
    for (const field of PRESERVED_FIELDS) {
      expect(patch).not.toHaveProperty(field);
    }
  });

  test('index patterns and exceptions survive even though sigma disagrees', () => {
    const patch = buildPatch(stackRule(), sigmaRule({ index: ['logs-*'] }));
    expect(patch.index).toBeUndefined();
    expect(patch.exceptions_list).toBeUndefined();
  });

  test('scheduling survives', () => {
    const patch = buildPatch(stackRule(), sigmaRule({ interval: '1m', from: 'now-2m' }));
    expect(patch.interval).toBeUndefined();
    expect(patch.from).toBeUndefined();
  });
});

describe('tags', () => {
  test('sigma tags are added and existing ones are kept', () => {
    const patch = buildPatch(stackRule(), sigmaRule());
    expect(patch.tags).toEqual(['team-tuned', 'attack.execution', 'attack.t1059.001']);
  });

  test('a tag the stack already has is not added twice', () => {
    const patch = buildPatch(
      stackRule({ tags: ['attack.execution', 'attack.t1059.001'] }),
      sigmaRule({ name: 'Suspicious PowerShell' })
    );
    expect(patch.tags).toBeUndefined(); // nothing to add, so tags aren't sent at all
  });

  test('a tag the stack has and sigma does not is never removed', () => {
    const patch = buildPatch(stackRule({ tags: ['do-not-delete'] }), sigmaRule());
    expect(patch.tags).toContain('do-not-delete');
  });
});

describe('diffRule', () => {
  test('reports one entry per changed field', () => {
    const changes = diffRule(stackRule(), sigmaRule());
    const fields = changes.map((c) => c.field);

    expect(fields).toEqual(expect.arrayContaining(['name', 'description', 'query', 'severity']));
    expect(fields).not.toContain('language'); // identical on both sides
  });

  test('an identical rule produces no changes at all', () => {
    const rule = stackRule();
    expect(diffRule(rule, { ...rule, rule_id: rule.rule_id })).toEqual([]);
  });

  test('array order is not a difference', () => {
    // Kibana returns references and threat entries in its own order. Without
    // this, every rule in the space reports drift and the command is useless
    const stack = stackRule({ references: ['https://b.example', 'https://a.example'] });
    const sigma = { ...stack, references: ['https://a.example', 'https://b.example'] };
    expect(diffRule(stack, sigma)).toEqual([]);
  });

  test('a fractional risk score is not a difference', () => {
    const stack = stackRule({ risk_score: 73 });
    expect(diffRule(stack, { ...stack, risk_score: 73.0 })).toEqual([]);
  });

  test('a field sigma did not produce is left alone rather than cleared', () => {
    const stack = stackRule({ note: 'analyst runbook' });
    const sigma = { ...stack };
    delete sigma.note;

    expect(diffRule(stack, sigma)).toEqual([]);
    expect(buildPatch(stack, sigma)).not.toHaveProperty('note');
  });
});

describe('buildCreateBody', () => {
  test('new rules are created disabled by default', () => {
    expect(buildCreateBody(sigmaRule()).enabled).toBe(false);
    expect(buildCreateBody(sigmaRule(), { enabled: true }).enabled).toBe(true);
  });

  test('server-owned fields are stripped', () => {
    const body = buildCreateBody({ ...sigmaRule(), id: 'x', created_at: 'y', immutable: true });
    expect(body.id).toBeUndefined();
    expect(body.created_at).toBeUndefined();
    expect(body.immutable).toBeUndefined();
    expect(body.rule_id).toBeDefined(); // this one has to survive - it is the match key
  });

  test('a new rule keeps the index patterns sigma converted for it', () => {
    // Nothing to preserve on a create, so the pipeline's guess is better than
    // no index at all
    expect(buildCreateBody(sigmaRule()).index).toEqual(['logs-*']);
  });
});

describe('contentHash', () => {
  test('is stable across key order and array order', () => {
    const a = contentHash({ name: 'x', tags: ['a', 'b'], severity: 'low' });
    const b = contentHash({ severity: 'low', tags: ['b', 'a'], name: 'x' });
    expect(a).toBe(b);
  });

  test('changes when the detection does', () => {
    expect(contentHash({ query: 'a' })).not.toBe(contentHash({ query: 'b' }));
  });
});