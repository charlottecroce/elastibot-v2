'use strict';

const { randomUUID } = require('crypto');
const config = require('../config');
const { JsonFileStore } = require('./store');
const { SEVERITY_RANK, UNKNOWN_RULE } = require('./constants');
const { caseUrl, isAbsoluteHttpUrl } = require('./services/kibanaLinks');
const { logger } = require('./util/logger');

const log = logger.child({ scope: 'incidents' });

/*
 * The incident store.
 *
 * watchers/alerts.js used to be stateless past the cursor: it grouped whatever
 * came back in one poll, posted a message, and forgot about it. Anything
 * arriving on the next tick became a second message with its own green "Create
 * case" button, and nothing could ever update a message already in the channel.
 *
 * An incident record is the durable half of a posted Slack message. It holds:
 *   - where the message lives (channel + ts) so we can chat.update it later
 *   - which alerts it currently shows        (alertIds)
 *   - which alerts are actually on the case  (attachedIds)
 *   - the case it belongs to, once one exists
 *   - a claim, held for the few seconds a case is being created
 *
 * pending = alertIds - attachedIds. That difference is the whole feature: it is
 * what the "N new alerts" section renders and what the "Add to case" button
 * attaches. It is only correct because cases are built from an explicit id list
 * rather than from a re-run query - see caseService.createCaseForIds
 *
 * LIFECYCLE
 *   idleMs         no new alerts for this long > the record is reaped and the
 *                  next alert on that host starts a fresh incident
 *   maxLifetimeMs  hard ceiling, so a host that trickles one alert every 7
 *                  hours can't accumulate a single unbounded incident forever
 *   claimTtlMs     a claim older than this is treated as abandoned (the handler
 *                  that took it crashed, or the process restarted mid-click)
 *
 * SINGLE PROCESS ASSUMPTION
 * tryClaim is a synchronous check-and-set on an in-memory object, so within one
 * Node process it is genuinely atomic - two clicks a millisecond apart cannot
 * both win. Across two Elastibot instances pointed at the same workspace it is
 * not. If you ever run more than one, this claim has to move to something with
 * a real compare-and-set (Redis SETNX, or an ES doc with an if_seq_no update)
 */

/*
 * Keys are generated, not derived.
 */
function newIncidentKey() {
  return randomUUID();
}

function toMs(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Set union, order preserved, no duplicates */
function union(a = [], b = []) {
  const seen = new Set(a);
  const out = [...a];
  for (const v of b) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

class IncidentStore extends JsonFileStore {
  constructor({
    filePath = config.security.incidentStorePath,
    debounceMs = 0,
    idleMs = config.incidents.idleMs,
    maxLifetimeMs = config.incidents.maxLifetimeMs,
    claimTtlMs = config.incidents.claimTtlMs,
  } = {}) {
    super({ filePath, debounceMs });
    this.idleMs = idleMs;
    this.maxLifetimeMs = maxLifetimeMs;
    this.claimTtlMs = claimTtlMs;

    // A crash mid-claim leaves a stale claim on disk. Nothing can be
    // mid-creation at boot, so clear them all rather than waiting out claimTtl
    let cleared = 0;
    for (const rec of Object.values(this.data)) {
      if (rec.claim) {
        rec.claim = null;
        cleared += 1;
      }
    }
    if (cleared) {
      this._persist();
      log.warn('cleared claims left over from a previous run', { count: cleared });
    }

    log.debug('incident store loaded', { filePath, incidents: Object.keys(this.data).length });
  }

  /** Raw record or null. Callers must not mutate it - go through the methods */
  get(key) {
    return this.data[key] || null;
  }

  all() {
    return Object.values(this.data);
  }

  /**
   * Find the open incident a freshly-grouped burst belongs to, or null.
   *
   * Matching is deliberately narrow. Same space and host is necessary but not
   * sufficient: two different analysts' sessions on one jump box are two
   * incidents, not one. We only join an existing record when the incoming
   * identities overlap it, or when every incoming identity is a machine one
   * (SYSTEM, a service account, a computer account, or absent) and so carries no
   * information that would contradict the match
   *
   * @param {object} group  a group from grouping.js
   * @param {number} [now]
   */
  findMatch(group, now = Date.now()) {
    const wantHost = group.hostName;
    if (!wantHost) return null; // no host, no correlation past the batch

    const incoming = group.userNames || (group.userName ? [group.userName] : []);

    let best = null;
    for (const rec of Object.values(this.data)) {
      if (rec.spaceId !== group.spaceId || rec.hostName !== wantHost) continue;
      if (!rec.messageTs) continue; // post failed or is still in flight
      if (this._isExpired(rec, now)) continue;

      const known = rec.userNames || [];
      const overlaps = incoming.some((u) => known.includes(u));

      // group.machineOnly is set by grouping.js when every alert in the burst
      // came from a machine identity
      if (!overlaps && !group.machineOnly && known.length && incoming.length) continue;

      // Most recently active wins if somehow there are two candidates
      if (!best || toMs(rec.lastActivityAt) > toMs(best.lastActivityAt)) best = rec;
    }
    return best;
  }

  /** The incident showing a given alert, or null. Used by /case and /add_alert
   *  so a case made from the command line still updates the block kit */
  findByAlertId(alertId) {
    for (const rec of Object.values(this.data)) {
      if (rec.alertIds.includes(alertId)) return rec;
    }
    return null;
  }

  /**
   * Create a record for an incident about to be posted.
   *
   * The record exists before the message does, so the caller must follow up
   * with setMessage once Slack returns a ts - or discard() if the post failed.
   * A record with no messageTs is inert: findMatch skips it, so a failed post
   * can't swallow the next tick's alerts into a message that isn't there
   *
   * @returns {object} the new record
   */
  open({ group, channel, spaceName }) {
    const nowIso = new Date().toISOString();
    const key = newIncidentKey();

    const rec = {
      key,
      spaceId: group.spaceId,
      hostName: group.hostName || null,
      userNames: group.userNames || (group.userName ? [group.userName] : []),
      primaryUser: group.userName || null,
      spaceName,

      channel,
      messageTs: null,

      alertIds: group.alerts.map((a) => a.id),
      attachedIds: [],

      /*
       * id > rule name for every alert on the message.
       * This is the source of truth for ruleCounts and representativeRule,
       * which are derived from it by _recount. The two can never disagree
       * because there is only one source
       */
      alertRules: Object.fromEntries(
        group.alerts.map((a) => [a.id, a.ruleName || UNKNOWN_RULE])
      ),

      caseId: null,
      caseLink: null,
      caseTitle: null,
      // The Kibana solution the case belongs to. Stored so a "View case" link
      // can be rebuilt from the record alone - see recordCase below
      caseOwner: null,
      claim: null,

      // Derived from alertRules by _recount, not stored independently
      ruleCounts: {},
      representativeRule: group.representativeRule,

      topSeverity: group.topSeverity,
      from: group.from,
      to: group.to,

      createdAt: nowIso,
      lastActivityAt: nowIso,
    };

    this.data[key] = rec;
    this._recount(rec);
    this._persist();
    return rec;
  }

  /** Drop a record whose message never made it to Slack */
  discard(key) {
    delete this.data[key];
    this._persist();
  }

  /**
   * Fold a newly-grouped burst into an existing incident.
   * @returns {{rec: object, addedIds: string[]}} addedIds is empty if every
   *   alert was already known, in which case the caller should skip the update
   */
  merge(key, group) {
    const rec = this.data[key];
    if (!rec) throw new Error(`no incident ${key}`);

    const incoming = group.alerts.map((a) => a.id);
    const known = new Set(rec.alertIds);
    const addedIds = incoming.filter((id) => !known.has(id));

    if (!addedIds.length) return { rec, addedIds };

    rec.alertIds = union(rec.alertIds, incoming);
    rec.userNames = union(rec.userNames, group.userNames || []);
    for (const a of group.alerts) rec.alertRules[a.id] = a.ruleName || UNKNOWN_RULE;
    this._recount(rec);

    // Severity only ever ratchets up - an incident that produced a critical
    // doesn't stop being critical because the next alert was low
    if ((SEVERITY_RANK[group.topSeverity] || 0) > (SEVERITY_RANK[rec.topSeverity] || 0)) {
      rec.topSeverity = group.topSeverity;
    }

    if (group.from < rec.from) rec.from = group.from;
    if (group.to > rec.to) rec.to = group.to;

    rec.lastActivityAt = new Date().toISOString();
    this._persist();
    return { rec, addedIds };
  }

  /** Alert ids shown in the block kit but not yet on the case */
  pending(rec) {
    if (!rec) return [];
    const attached = new Set(rec.attachedIds);
    return rec.alertIds.filter((id) => !attached.has(id));
  }

  /**
   * Rule breakdown over a subset of a record's alerts. Pass no ids for the
   * whole incident, or the pending ids for the "N new alerts" section
   */
  ruleCountsFor(rec, ids) {
    const counts = {};
    for (const id of ids || rec.alertIds) {
      const rule = rec.alertRules?.[id];
      if (!rule) continue;
      counts[rule] = (counts[rule] || 0) + 1;
    }
    return counts;
  }

  /** Recompute the cached breakdown from alertRules. Cheap, and the two can
   *  never disagree because there is only one source */
  _recount(rec) {
    rec.ruleCounts = this.ruleCountsFor(rec);
    rec.representativeRule =
      Object.entries(rec.ruleCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ||
      rec.representativeRule;
  }

  /*
   * ---- claims ----------------------------------------------------------
   * The button swap is cosmetic; this is the thing that actually makes a
   * duplicate case impossible. Take the claim BEFORE any Elastic call
   */

  /**
   * @param {string} key
   * @param {string} slackUserId
   * @param {object} [opts]
   * @param {boolean} [opts.allowExistingCase] the add-alerts path needs the
   *   mutual exclusion (Kibana's attach is not idempotent, two clicks would
   *   double-attach) but an existing case is its precondition, not a refusal
   * @param {number} [opts.now]
   * @returns {{ok: boolean, reason?: string, rec: object|null}}
   *   reason 'case_exists' > tell the analyst to use the existing case
   *   reason 'claimed'     > another analyst is mid-click, tell them to wait
   *   reason 'gone'        > the incident was reaped out from under the message
   */
  tryClaim(key, slackUserId, { allowExistingCase = false, now = Date.now() } = {}) {
    const rec = this.data[key];
    if (!rec) return { ok: false, reason: 'gone', rec: null };

    if (rec.caseId && !allowExistingCase) return { ok: false, reason: 'case_exists', rec };

    if (rec.claim && now - toMs(rec.claim.at) < this.claimTtlMs) {
      return { ok: false, reason: 'claimed', rec };
    }

    rec.claim = { by: slackUserId, at: new Date(now).toISOString() };
    this._persist();
    return { ok: true, rec };
  }

  releaseClaim(key) {
    const rec = this.data[key];
    if (!rec || !rec.claim) return;
    rec.claim = null;
    this._persist();
  }

  /**
   * Record the case and mark which alerts made it on. Clears the claim.
   *
   * @param {string} key
   * @param {{caseId: string, link?: string, title?: string, owner?: string}} result
   * @param {string[]} [attachedIds]
   */
  recordCase(key, { caseId, link, title, owner }, attachedIds = []) {
    const rec = this.data[key];
    if (!rec) return null;

    rec.caseId = caseId;
    rec.caseTitle = title;
    rec.caseOwner = owner || null;
    rec.caseLink = isAbsoluteHttpUrl(link) ? link : caseUrl(rec.spaceId, caseId, owner);
    rec.attachedIds = union(rec.attachedIds, attachedIds);
    rec.claim = null;
    rec.lastActivityAt = new Date().toISOString();
    this._persist();
    return rec;
  }

  /** Mark additional alerts as attached to the existing case */
  recordAttached(key, ids = []) {
    const rec = this.data[key];
    if (!rec) return null;
    rec.attachedIds = union(rec.attachedIds, ids);
    rec.claim = null;
    rec.lastActivityAt = new Date().toISOString();
    this._persist();
    return rec;
  }

  /** The Slack message moved or was reposted */
  setMessage(key, { channel, messageTs }) {
    const rec = this.data[key];
    if (!rec) return null;
    rec.channel = channel;
    rec.messageTs = messageTs;
    this._persist();
    return rec;
  }

  /*
   * ---- reaping ---------------------------------------------------------
   */

  _isExpired(rec, now = Date.now()) {
    if (now - toMs(rec.lastActivityAt) >= this.idleMs) return true;
    if (now - toMs(rec.createdAt) >= this.maxLifetimeMs) return true;
    return false;
  }

  /**
   * Drop records past their idle window or lifetime cap. Called at the top of
   * every alert poll, so the store stays bounded without its own timer
   *
   * A reaped incident is not deleted from Slack - the message stays in the
   * channel with whatever buttons it last had. Its "Add to case" button will
   * report that the incident has closed out rather than silently doing nothing
   *
   * @returns {number} records removed
   */
  sweep(now = Date.now()) {
    let removed = 0;
    for (const [key, rec] of Object.entries(this.data)) {
      if (!this._isExpired(rec, now)) continue;
      delete this.data[key];
      removed += 1;
      log.debug('incident reaped', {
        key,
        host: rec.hostName,
        alerts: rec.alertIds.length,
        caseId: rec.caseId,
        ageMs: now - toMs(rec.createdAt),
      });
    }
    if (removed) {
      this._persist();
      log.info('incidents reaped', { removed, remaining: Object.keys(this.data).length });
    }
    return removed;
  }
}

module.exports = { IncidentStore, newIncidentKey };