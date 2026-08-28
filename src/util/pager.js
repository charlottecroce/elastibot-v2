'use strict';

const { randomUUID } = require('crypto');
const { TtlCache } = require('./cache');
const { UserFacingError } = require('./errors');

/*
 * Paged result sets, held between button clicks.
 *
 * Generic on purpose. Any module that answers with more rows than fit in one
 * Slack message needs the same three things: park the result somewhere, hand
 * the buttons a token instead of the data, and clamp whatever page comes back.
 * Nothing here knows what an item is, so the next module gets paging by calling
 * createPager rather than by copying services/sigmaSession.js.
 *
 * Each caller gets its own cache, so one module's TTL and page size are not
 * another's, and one module filling its cache cannot evict another's sessions.
 *
 * In memory only. A restart drops every open pager, which is the right trade
 * for results that were a snapshot of something that keeps moving
 */

const DEFAULT_EXPIRED = 'That result set has expired. Run the command again.';
const TOKEN_LENGTH = 12;

/**
 * @param {object} opts
 * @param {number} opts.ttlMs             how long a result set stays clickable
 * @param {number} [opts.max]             cap on concurrent result sets
 * @param {number} [opts.pageSize]        items per page
 * @param {string} [opts.expiredMessage]  what an analyst sees on a dead token
 */
function createPager({ ttlMs, max = 200, pageSize = 10, expiredMessage = DEFAULT_EXPIRED }) {
  if (!ttlMs) throw new Error('createPager needs a ttlMs');
  if (pageSize < 1) throw new Error('createPager needs a pageSize of at least 1');

  const sessions = new TtlCache({ ttlMs, max });

  /**
   * Store a result set and hand back the stored copy.
   *
   * The stored object is returned rather than just its token, so a caller
   * rendering page 1 holds the same object a later click will fetch - two
   * copies drifting apart is the bug this would be worst at
   *
   * @param {object} data { slackUserId, items, ...whatever the module needs }
   * @returns {object} the stored session, including its `token`
   */
  function create(data) {
    const token = randomUUID().slice(0, TOKEN_LENGTH);
    const session = { ...data, token, createdAt: Date.now() };
    sessions.set(token, session);
    return session;
  }

  /**
   * Fetch a session, or explain why it isn't there.
   *
   * The owner check is belt and braces - these render into ephemeral messages
   * nobody else can see or click - but a token is a capability and it costs one
   * comparison to keep it from being a shared one
   */
  function get(token, slackUserId) {
    const session = sessions.get(token);
    if (!session) throw new UserFacingError(expiredMessage);
    if (slackUserId && session.slackUserId !== slackUserId) {
      throw new UserFacingError('That result set belongs to someone else.');
    }
    return session;
  }

  /** Total pages, never less than one */
  function pageCount(session) {
    return Math.max(1, Math.ceil((session.items?.length || 0) / pageSize));
  }

  /** Clamp a requested page and return its slice */
  function pageOf(session, requested) {
    const total = pageCount(session);
    const page = Math.min(Math.max(1, Math.trunc(Number(requested)) || 1), total);
    const start = (page - 1) * pageSize;
    return {
      page,
      total,
      start,
      items: (session.items || []).slice(start, start + pageSize),
    };
  }

  /**
   * One item by the index a button carried.
   *
   * The index arrives as JSON from Slack, so it is validated rather than used
   * straight as a subscript: `items[undefined]` is a button that silently does
   * nothing, which is the hardest kind of bug to get reported
   *
   * @returns {object|null} null when the index doesn't address an item
   */
  function itemAt(session, index) {
    const i = Math.trunc(Number(index));
    if (!Number.isInteger(i) || i < 0 || i >= (session.items?.length || 0)) return null;
    return session.items[i];
  }

  return {
    EXPIRED: expiredMessage,
    pageSize,
    create,
    get,
    pageCount,
    pageOf,
    itemAt,
    clear: () => sessions.clear(),
    get size() {
      return sessions.size;
    },
  };
}

/** JSON, because a delimiter would eventually meet a space id containing it */
function packValue(payload) {
  return JSON.stringify(payload);
}

/**
 * A Slack action value back into an object.
 *
 * Anything unparseable is treated as expired rather than as a defect: the only
 * way to hold a malformed value is to have clicked a button from a message old
 * enough to predate the current format
 */
function unpackValue(value, expiredMessage = DEFAULT_EXPIRED) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw new UserFacingError(expiredMessage);
  }
}

module.exports = { createPager, packValue, unpackValue, DEFAULT_EXPIRED };