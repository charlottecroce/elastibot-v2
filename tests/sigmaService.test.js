'use strict';

jest.mock('../src/elastic');
jest.mock('../src/sigma/db');

const config = require('../config');
const db = require('../src/sigma/db');
const { createElasticClient } = require('../src/elastic');
const {
  parseSigmaCommand,
  compareSpace,
  updateStackRule,
  STATE,
} = require('../src/services/sigmaService');
const { createSession, getSession, pageOf, clear } = require('../src/services/sigmaSession');
const { UserFacingError } = require('../src/util/errors');

/*
 * Neither Elasticsearch nor Prisma is real here. What is being tested is the
 * part that decides which rules are even eligible - the skip rules the whole
 * command rests on - and the paging that keeps a five-hundred-rule answer from
 * being posted into Slack in one message
 */

const RULE_ID = '67f113fa-e23d-4271-befa-30113b3e08b1';

function stackRule(over = {}) {
  return {
    id: 'kibana-1',
    rule_id: RULE_ID,
    name: 'Suspicious PowerShell',
    description: 'old',
    severity: 'low',
    tags: [],
    immutable: false,
    ...over,
  };
}

function sigmaRecord(over = {}) {
  return {
    ruleId: RULE_ID,
    title: 'Suspicious PowerShell',
    converted: { rule_id: RULE_ID, name: 'Suspicious PowerShell', severity: 'high' },
    ...over,
  };
}

/** A fake client whose _find returns one page of the given rules */
function fakeClient(rules) {
  return {
    findDetectionRules: jest.fn().mockResolvedValue({ total: rules.length, data: rules }),
    getDetectionRuleByRuleId: jest.fn(async (_space, ruleId) =>
      rules.find((r) => r.rule_id === ruleId) || null
    ),
    patchDetectionRule: jest.fn().mockResolvedValue({}),
    createDetectionRule: jest.fn().mockResolvedValue({ id: 'new-1', name: 'New' }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  clear();
  db.isReady.mockReturnValue(true);
});

describe('parseSigmaCommand', () => {
  test('reads the subcommand', () => {
    expect(parseSigmaCommand('update').sub).toBe('update');
    expect(parseSigmaCommand('status').sub).toBe('status');
  });

  test('space: is pulled out wherever it appears', () => {
    expect(parseSigmaCommand('update space:soc').spaceId).toBe('soc');
    expect(parseSigmaCommand('search space:soc brute force').spaceId).toBe('soc');
    expect(parseSigmaCommand('search brute force space:soc').query).toBe('brute force');
  });

  test('no space: means no space - it is never guessed', () => {
    expect(parseSigmaCommand('update').spaceId).toBeNull();
  });

  test('a bare keyword is a search, quoted or not', () => {
    expect(parseSigmaCommand('brute force')).toMatchObject({ sub: 'search', query: 'brute force' });
    expect(parseSigmaCommand("search 'brute force'").query).toBe('brute force');
  });

  test('empty text asks for help rather than searching for nothing', () => {
    expect(parseSigmaCommand('').sub).toBe('help');
  });
});

describe('compareSpace: which rules are eligible', () => {
  test('a rule with no rule_id is skipped', () => {
    // Hand-written and prebuilt Elastic rules both have `id`; only Sigma-derived
    // ones carry a `rule_id` we can match
    const client = fakeClient([stackRule(), { id: 'kibana-2', name: 'Custom rule' }]);
    createElasticClient.mockReturnValue(client);
    db.getRulesByIds.mockResolvedValue(new Map([[RULE_ID, sigmaRecord()]]));

    return compareSpace('key', 'soc').then((result) => {
      expect(db.getRulesByIds).toHaveBeenCalledWith([RULE_ID]);
      expect(result.counts.examined).toBe(2);
      expect(result.counts.withRuleId).toBe(1);
    });
  });

  test('a rule_id the database has never heard of is skipped', async () => {
    const client = fakeClient([stackRule({ rule_id: 'not-a-sigma-rule' })]);
    createElasticClient.mockReturnValue(client);
    db.getRulesByIds.mockResolvedValue(new Map());

    const result = await compareSpace('key', 'soc');
    expect(result.counts.matched).toBe(0);
    expect(result.items).toEqual([]);
  });

  test('a rule that matches and is up to date is not listed', async () => {
    const rule = stackRule({ severity: 'high' });
    createElasticClient.mockReturnValue(fakeClient([rule]));
    db.getRulesByIds.mockResolvedValue(new Map([[RULE_ID, sigmaRecord()]]));

    const result = await compareSpace('key', 'soc');
    expect(result.counts.matched).toBe(1);
    expect(result.items).toEqual([]);
  });

  test('a drifted rule is listed with the fields that differ', async () => {
    createElasticClient.mockReturnValue(fakeClient([stackRule()]));
    db.getRulesByIds.mockResolvedValue(new Map([[RULE_ID, sigmaRecord()]]));

    const result = await compareSpace('key', 'soc');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].changes.map((c) => c.field)).toContain('severity');
    expect(result.items[0].state).toBe(STATE.OUTDATED);
  });

  test('an Elastic-managed rule is listed but not offered as updatable', async () => {
    createElasticClient.mockReturnValue(fakeClient([stackRule({ immutable: true })]));
    db.getRulesByIds.mockResolvedValue(new Map([[RULE_ID, sigmaRecord()]]));

    const result = await compareSpace('key', 'soc');
    expect(result.items[0].state).toBe(STATE.BLOCKED);
  });

  test('an unbuilt database is reported, not crashed into', async () => {
    db.isReady.mockReturnValue(false);
    await expect(compareSpace('key', 'soc')).rejects.toBeInstanceOf(UserFacingError);
  });
});

describe('updateStackRule', () => {
  test('re-reads both sides before patching', async () => {
    // The session's diff is a snapshot; somebody may have edited the rule in
    // Kibana since it was rendered
    const client = fakeClient([stackRule()]);
    createElasticClient.mockReturnValue(client);
    db.getRule.mockResolvedValue(sigmaRecord());

    const result = await updateStackRule('key', 'soc', RULE_ID);

    expect(client.getDetectionRuleByRuleId).toHaveBeenCalledWith('soc', RULE_ID);
    expect(client.patchDetectionRule).toHaveBeenCalledWith(
      'soc',
      expect.objectContaining({ rule_id: RULE_ID, severity: 'high' })
    );
    expect(result.changes.map((c) => c.field)).toContain('severity');
  });

  test('a rule that is already current is not patched again', async () => {
    createElasticClient.mockReturnValue(fakeClient([stackRule({ severity: 'high' })]));
    db.getRule.mockResolvedValue(sigmaRecord());

    const result = await updateStackRule('key', 'soc', RULE_ID);
    expect(result.alreadyCurrent).toBe(true);
  });

  test('a rule deleted since the page was rendered fails with an explanation', async () => {
    createElasticClient.mockReturnValue(fakeClient([]));
    db.getRule.mockResolvedValue(sigmaRecord());

    await expect(updateStackRule('key', 'soc', RULE_ID)).rejects.toThrow(/no longer in space/);
  });

  test('an Elastic-managed rule is refused rather than 400ing against Kibana', async () => {
    createElasticClient.mockReturnValue(fakeClient([stackRule({ immutable: true })]));
    db.getRule.mockResolvedValue(sigmaRecord());

    await expect(updateStackRule('key', 'soc', RULE_ID)).rejects.toThrow(/Elastic-managed/);
  });
});

describe('paging', () => {
  const session = (count) => ({
    kind: 'update',
    slackUserId: 'U1',
    items: Array.from({ length: count }, (_, i) => ({ i })),
  });

  test('splits into pages of config.sigma.pageSize', () => {
    const s = session(25);
    expect(pageOf(s, 1).items).toHaveLength(config.sigma.pageSize);
    expect(pageOf(s, 1).total).toBe(Math.ceil(25 / config.sigma.pageSize));
  });

  test('a page past the end clamps to the last one instead of rendering nothing', () => {
    expect(pageOf(session(5), 99).page).toBe(1);
  });

  test('an empty result set is still one page', () => {
    expect(pageOf(session(0), 1).total).toBe(1);
  });

  test('an expired token is explained rather than thrown as a defect', () => {
    expect(() => getSession('nope', 'U1')).toThrow(UserFacingError);
  });

  test('a token belongs to the analyst who made it', () => {
    const { token } = createSession({ ...session(1), slackUserId: 'U1' });
    expect(getSession(token, 'U1')).toBeTruthy();
    expect(() => getSession(token, 'U2')).toThrow(UserFacingError);
  });
});