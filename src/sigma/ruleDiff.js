'use strict';

const crypto = require('crypto');

/*
 * What a Sigma rule owns, and what the stack owns.
 *
 * This file is pure: no config, no I/O, no Slack. It is required by both the
 * sync (to hash a converted rule) and the service layer (to diff and patch
 * one), which is why it sits down here rather than in services/
 *
 * The split below is the whole feature in one list. A Sigma rule is a
 * DETECTION - logic, naming, severity, ATT&CK mapping. Everything an analyst
 * tuned locally - which indices it runs against, its exceptions, its schedule,
 * the fields they chose to highlight - belongs to the stack and is never
 * touched. PATCH is used rather than PUT precisely so that omitting a field
 * means "leave it alone" instead of "clear it"
 */

/** Fields taken from Sigma and pushed onto the stack rule */
const SYNCED_FIELDS = Object.freeze([
  'name',
  'description',
  'query',
  'language',
  'severity',
  'risk_score',
  'references',
  'false_positives',
  'threat',
  'author',
  'license',
  'note',
]);

/**
 * Fields that stay whatever the analyst made them. Listed for documentation and
 * for the create path; the update path can't touch them anyway, because a PATCH
 * only carries SYNCED_FIELDS plus tags
 */
const PRESERVED_FIELDS = Object.freeze([
  'index', // index patterns
  'data_view_id',
  'exceptions_list', // exceptions
  'investigation_fields', // custom highlighted fields
  'interval', // scheduling
  'from',
  'to',
  'max_signals',
  'enabled',
  'actions',
  'throttle',
  'meta',
  'filters',
  'timeline_id',
  'timeline_title',
  'outcome',
  'namespace',
]);

/** Server-managed fields that must not be sent back on a create */
const READ_ONLY_FIELDS = Object.freeze([
  'id',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
  'revision',
  'immutable',
  'rule_source',
  'execution_summary',
  'related_integrations',
  'required_fields',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Put a value into a form where "same content, different shape" compares equal.
 *
 * Kibana reorders arrays of objects and rounds risk_score, so a raw deep-equal
 * reports a difference on every single rule and the command becomes useless
 */
function normalize(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Math.round(value);
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const items = value.map(normalize).filter((v) => v !== null && v !== '');
    // Sorted by their serialized form: order is not meaningful in any of the
    // arrays we sync (references, tags, false positives, threat entries)
    return items.map((v) => JSON.stringify(v)).sort().map((v) => JSON.parse(v));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = normalize(value[key]);
      if (v !== null && v !== '') out[key] = v;
    }
    return out;
  }
  return value;
}

const same = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

/** Stable hash of just the fields we sync, for cheap change detection */
function contentHash(rule) {
  const subject = {};
  for (const field of SYNCED_FIELDS) subject[field] = normalize(rule[field]);
  subject.tags = normalize(rule.tags || []);
  return sha256(JSON.stringify(subject));
}

/** Tags the Sigma rule has and the stack rule doesn't. Nothing is ever removed */
function missingTags(stackRule, sigmaRule) {
  const existing = new Set((stackRule.tags || []).map((t) => String(t)));
  return (sigmaRule.tags || []).map((t) => String(t)).filter((t) => !existing.has(t));
}

/**
 * What would change if this Sigma rule were applied to this stack rule.
 *
 * @returns {Array<{field: string, from: *, to: *}>} empty when up to date
 */
function diffRule(stackRule, sigmaRule) {
  const changes = [];

  for (const field of SYNCED_FIELDS) {
    const to = sigmaRule[field];
    if (to === undefined) continue; // the conversion didn't produce it - not a change
    if (!same(stackRule[field], to)) {
      changes.push({ field, from: stackRule[field], to });
    }
  }

  const added = missingTags(stackRule, sigmaRule);
  if (added.length) {
    changes.push({ field: 'tags', from: stackRule.tags || [], to: added, added });
  }

  return changes;
}

/**
 * The PATCH body that applies a Sigma rule to an existing stack rule.
 *
 * Keyed by rule_id, carries only synced fields, and merges tags rather than
 * replacing them. Anything in PRESERVED_FIELDS is simply absent, which is what
 * makes the "don't touch my index patterns" guarantee structural rather than a
 * promise in a comment
 */
function buildPatch(stackRule, sigmaRule) {
  const patch = { rule_id: sigmaRule.rule_id };

  for (const field of SYNCED_FIELDS) {
    const to = sigmaRule[field];
    if (to === undefined) continue;
    if (!same(stackRule[field], to)) patch[field] = to;
  }

  const added = missingTags(stackRule, sigmaRule);
  if (added.length) patch.tags = [...(stackRule.tags || []), ...added];

  return patch;
}

/**
 * The POST body that creates a rule the stack doesn't have yet.
 *
 * Nothing is preserved here - there is nothing to preserve - so the converted
 * rule goes over whole, minus the fields the server owns
 */
function buildCreateBody(sigmaRule, { enabled = false } = {}) {
  const body = { ...sigmaRule };
  for (const field of READ_ONLY_FIELDS) delete body[field];
  body.enabled = enabled;
  return body;
}

module.exports = {
  SYNCED_FIELDS,
  PRESERVED_FIELDS,
  READ_ONLY_FIELDS,
  sha256,
  normalize,
  same,
  contentHash,
  missingTags,
  diffRule,
  buildPatch,
  buildCreateBody,
};