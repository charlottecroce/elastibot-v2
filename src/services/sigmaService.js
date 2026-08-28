'use strict';

const config = require('../../config');
const db = require('../sigma/db');
const { STATE } = require('../sigma/state');
const { diffRule, buildPatch, buildCreateBody } = require('../sigma/ruleDiff');
const { unquote } = require('../sigma/parse');
const { createElasticClient } = require('../elastic');
const { getSpaceName } = require('./spaceService');
const { UserFacingError, describeAxiosError } = require('../util/errors');
const { logger } = require('../util/logger');

/*
 * Everything /sigma does that isn't Slack.
 *
 * commands/sigma.js stays registration and routing; the block kit lives in
 * services/sigmaBlocks.js; the field-level rules live in sigma/ruleDiff.js.
 * This file is the part that talks to both Elasticsearch and the database
 */

const log = logger.child({ scope: 'service:sigma' });

const SIGMA_USAGE =
  '*Usage:* `/sigma <subcommand>`\n' +
  '• `/sigma update [space:<id>]` - compare every detection rule in a space against the ' +
  'Sigma database and offer to update the ones that have drifted\n' +
  '• `/sigma search <keyword> [space:<id>]` - find Sigma rules by title or description\n' +
  '• `/sigma status` - when the database was last synced\n' +
  '_e.g._ `/sigma search brute force space:soc`';

/** Longest keyword worth sending at a LIKE over a few thousand titles */
const MAX_QUERY_LENGTH = 200;

const SUBCOMMANDS = new Set(['update', 'search', 'status', 'help']);

/**
 * Sigma ids are UUIDs, and case is not meaningful in one.
 *
 * The database stores them as sigma-cli emitted them and Kibana stores whatever
 * it was handed, so every comparison between the two sides goes through here
 * rather than relying on the two having agreed
 */
function normalizeRuleId(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Parse the slash command text.
 *
 * `space:` may appear anywhere; everything else is the query, so a keyword with
 * spaces needs no quoting (though quoting it works too).
 *
 * Anything that isn't a known subcommand is treated as a search term, so
 * `/sigma brute force` and `/sigma search brute force` do the same thing -
 * people type the short one
 *
 * @returns {{sub: string, query: string, spaceId: string|null}}
 */
function parseSigmaCommand(text) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  const first = (tokens[0] || 'help').toLowerCase();
  const sub = SUBCOMMANDS.has(first) ? first : 'search';
  if (SUBCOMMANDS.has(first)) tokens.shift();

  let spaceId = null;
  const rest = [];
  for (const token of tokens) {
    const match = /^space:(.*)$/i.exec(token);
    if (match) spaceId = unquote(match[1]) || null;
    else rest.push(token);
  }

  return { sub, query: unquote(rest.join(' ')).slice(0, MAX_QUERY_LENGTH), spaceId };
}

/** Guard every entry point that needs the database, with an actionable message */
function requireDatabase() {
  if (!db.isReady()) throw new UserFacingError(db.NOT_READY);
}

/** Spaces the analyst's key can see, for the picker */
async function listSpaces(apiKey) {
  const client = createElasticClient(apiKey);
  try {
    const spaces = await client.getSpaces();
    if (!spaces.length) throw new UserFacingError('No Kibana spaces are visible to your API key.');
    return spaces;
  } catch (err) {
    if (err instanceof UserFacingError) throw err;
    throw describeAxiosError(err, 'Listing spaces');
  }
}

/**
 * Every detection rule in a space.
 *
 * Paged rather than asked for in one go: Kibana's _find caps per_page, and a
 * mature stack has thousands of rules. maxStackRules is the circuit breaker -
 * it stops one command walking a cluster forever.
 *
 * A short page ends the walk. The old condition only looked at `total`, so a
 * stack that reported a stale total kept asking for pages that came back empty
 */
async function loadStackRules(client, spaceId) {
  const perPage = config.sigma.stackPageSize;
  const max = config.sigma.maxStackRules;
  const rules = [];
  let page = 1;
  let total = 0;

  while (rules.length < max) {
    const result = await client.findDetectionRules(spaceId, { page, perPage });
    total = result.total ?? total;

    const batch = result.data || [];
    if (!batch.length) break;
    rules.push(...batch);

    if (batch.length < perPage || rules.length >= total) break;
    page += 1;
  }

  return { rules, total, truncated: rules.length < total };
}

/**
 * /sigma update: diff a whole space against the database.
 *
 * A rule is skipped when it has no `rule_id` (not the `id` field, which every
 * rule has) or when its rule_id isn't in the database - that is how Elastic
 * prebuilt and hand-written rules stay out of the way without needing to be
 * recognised individually
 */
async function compareSpace(apiKey, spaceId) {
  requireDatabase();
  const client = createElasticClient(apiKey);

  let stack;
  try {
    stack = await loadStackRules(client, spaceId);
  } catch (err) {
    throw describeAxiosError(err, 'Listing detection rules');
  }

  const withRuleId = stack.rules.filter((rule) => rule.rule_id);
  const sigmaRules = await db.getRulesByIds(withRuleId.map((rule) => rule.rule_id));

  const items = [];
  let matched = 0;

  for (const stackRule of withRuleId) {
    const sigma = sigmaRules.get(normalizeRuleId(stackRule.rule_id));
    if (!sigma) continue;
    matched += 1;

    const changes = diffRule(stackRule, sigma.converted);
    if (!changes.length) continue;

    items.push({
      i: items.length,
      ruleId: stackRule.rule_id,
      stackId: stackRule.id,
      name: stackRule.name,
      sigmaTitle: sigma.title,
      changes,
      // Elastic-managed rules reject a patch, so say so up front instead of
      // rendering a button that always fails
      state: stackRule.immutable ? STATE.BLOCKED : STATE.OUTDATED,
    });
  }

  log.info('space compared against sigma database', {
    spaceId,
    stackRules: stack.rules.length,
    withRuleId: withRuleId.length,
    matched,
    drifted: items.length,
    truncated: stack.truncated,
  });

  return {
    kind: 'update',
    spaceId,
    items,
    counts: {
      examined: stack.rules.length,
      withRuleId: withRuleId.length,
      matched,
      drifted: items.length,
    },
    truncated: stack.truncated,
  };
}

/** /sigma search: keyword over the database. Stack state is resolved per page */
async function searchSigmaRules(query) {
  requireDatabase();
  if (!query) {
    throw new UserFacingError('Give me something to search for, e.g. `/sigma brute force`.');
  }

  const rules = await db.searchRules(query, config.sigma.maxSearchResults);

  return {
    kind: 'search',
    query,
    items: rules.map((rule, i) => ({
      i,
      ruleId: rule.ruleId,
      title: rule.title,
      description: rule.description,
      level: rule.level,
      state: STATE.UNKNOWN,
      changes: [],
    })),
  };
}

/**
 * Fill in the stack state for the items on one page.
 *
 * Done a page at a time rather than up front. Deciding Add vs Update vs View
 * needs the stack's copy of each rule, and fetching two hundred of those to
 * render ten of them is a lot of round trips nobody asked for
 */
async function resolvePageState(apiKey, spaceId, items) {
  const client = createElasticClient(apiKey);
  const pending = items.filter((item) => item.state === STATE.UNKNOWN);
  if (!pending.length) return items;

  /*
   * Decide first, write afterwards.
   *
   * Each lookup returns the fields it wants set rather than reaching back into
   * the item it came from, and every item is updated in one synchronous pass
   * once all of them have resolved. Interleaved awaits writing to shared
   * objects is the shape require-atomic-updates exists to flag, and here it
   * would be a real hazard: two pages of the same session can be in flight at
   * once, and a half-updated item renders a button that contradicts its own
   * status line
   */
  const resolved = await Promise.all(
    pending.map(async (item) => {
      const [stackRule, sigma] = await Promise.all([
        client.getDetectionRuleByRuleId(spaceId, item.ruleId),
        db.getRule(item.ruleId),
      ]);

      if (!stackRule) return { item, fields: { state: STATE.MISSING } };

      const changes = sigma ? diffRule(stackRule, sigma.converted) : [];
      let state = STATE.CURRENT;
      if (stackRule.immutable) state = STATE.BLOCKED;
      else if (changes.length) state = STATE.OUTDATED;

      return { item, fields: { state, stackId: stackRule.id, changes } };
    })
  );

  for (const { item, fields } of resolved) Object.assign(item, fields);

  return items;
}

/**
 * Apply one Sigma rule to the rule already in the stack.
 *
 * Both sides are re-read first. The session's diff is a snapshot, and between
 * rendering it and the click somebody may have edited the rule in Kibana - in
 * which case we want to patch what is there now, not what was there then
 */
async function updateStackRule(apiKey, spaceId, ruleId) {
  requireDatabase();
  const client = createElasticClient(apiKey);

  const sigma = await db.getRule(ruleId);
  if (!sigma) throw new UserFacingError(`\`${ruleId}\` is not in the Sigma database.`);

  let stackRule;
  try {
    stackRule = await client.getDetectionRuleByRuleId(spaceId, ruleId);
  } catch (err) {
    throw describeAxiosError(err, 'Looking up the detection rule');
  }
  if (!stackRule) {
    throw new UserFacingError(`\`${ruleId}\` is no longer in space \`${spaceId}\`.`);
  }
  if (stackRule.immutable) {
    throw new UserFacingError(
      `\`${stackRule.name}\` is an Elastic-managed rule and can't be patched. ` +
        'Duplicate it in Kibana first if you want the Sigma version.'
    );
  }

  const changes = diffRule(stackRule, sigma.converted);
  if (!changes.length) {
    return {
      ruleId,
      name: stackRule.name,
      stackId: stackRule.id,
      changes: [],
      alreadyCurrent: true,
    };
  }

  const patch = buildPatch(stackRule, sigma.converted);
  try {
    await client.patchDetectionRule(spaceId, patch);
  } catch (err) {
    throw describeAxiosError(err, 'Updating the detection rule');
  }

  log.info('detection rule updated from sigma', {
    spaceId,
    ruleId,
    fields: changes.map((c) => c.field),
  });

  return {
    ruleId,
    name: sigma.converted.name || stackRule.name,
    stackId: stackRule.id,
    changes,
    alreadyCurrent: false,
  };
}

/** Create a rule the space doesn't have. Disabled by default - see config.sigma */
async function createStackRule(apiKey, spaceId, ruleId) {
  requireDatabase();
  const client = createElasticClient(apiKey);

  const sigma = await db.getRule(ruleId);
  if (!sigma) throw new UserFacingError(`\`${ruleId}\` is not in the Sigma database.`);

  const body = buildCreateBody(sigma.converted, { enabled: config.sigma.enableNewRules });

  let created;
  try {
    created = await client.createDetectionRule(spaceId, body);
  } catch (err) {
    const e = describeAxiosError(err, 'Creating the detection rule');
    if (e.status === 409) {
      throw new UserFacingError(`\`${sigma.title}\` already exists in space \`${spaceId}\`.`);
    }
    throw e;
  }

  log.info('detection rule created from sigma', {
    spaceId,
    ruleId,
    enabled: config.sigma.enableNewRules,
  });

  return { ruleId, name: created.name, stackId: created.id, enabled: config.sigma.enableNewRules };
}

/**
 * Display name for a space id, for the headings.
 *
 * Never fails the command: spaceService swallows a lookup failure and falls
 * back to the id, and a missing API key is caught here for the same reason -
 * losing a whole result set over a cosmetic heading is a bad trade
 */
async function resolveSpaceName(apiKey, spaceId) {
  try {
    return await getSpaceName(spaceId, createElasticClient(apiKey));
  } catch (err) {
    log.warn('space name lookup failed - using the id', { err, spaceId });
    return spaceId;
  }
}

/** For `/sigma status` */
async function getSyncStatus() {
  requireDatabase();
  const [meta, count] = await Promise.all([db.getMeta(), db.countRules()]);
  return { meta, count };
}

module.exports = {
  SIGMA_USAGE,
  STATE, // re-exported: it lives in sigma/state.js so the block kit can have it too
  normalizeRuleId,
  parseSigmaCommand,
  listSpaces,
  compareSpace,
  searchSigmaRules,
  resolvePageState,
  updateStackRule,
  createStackRule,
  resolveSpaceName,
  getSyncStatus,
  loadStackRules,
};