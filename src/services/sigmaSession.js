'use strict';

const { randomUUID } = require('crypto');
const config = require('../../config');
const { TtlCache } = require('../util/cache');
const { UserFacingError } = require('../util/errors');

/*
 * Paged results live here between clicks.
 *
 * A page button could in principle carry everything needed to rebuild its page,
 * but /sigma update is a full sweep of every detection rule in a space diffed
 * against the database - doing that again on every "next" click would make
 * paging cost more than the command did. So the result set is computed once,
 * parked in a TTL cache, and the button carries a token into it.
 *
 * It also sidesteps the 2000-character ceiling on a Slack action value, which a
 * search query plus a space id plus a rule id would flirt with.
 *
 * In memory only. A restart drops every open pager, and that is the right
 * trade: the results were a snapshot of a cluster that has since moved on
 */

const sessions = new TtlCache({
  ttlMs: config.sigma.sessionTtlMs,
  max: config.sigma.maxSessions,
});

const EXPIRED = 'That result set has expired. Run the command again.';

/**
 * Store a result set and hand back the stored copy.
 *
 * The stored object is returned rather than just its token so that a caller
 * rendering page 1 is holding the same object a later click will fetch - two
 * copies drifting apart is exactly the bug this feature would be worst at
 *
 * @param {object} data  { kind, slackUserId, spaceId, spaceName, query, items, ... }
 * @returns {object} the stored session, including its `token`
 */
function createSession(data) {
  const token = randomUUID().slice(0, 12);
  const session = { ...data, token, createdAt: Date.now() };
  sessions.set(token, session);
  return session;
}

/**
 * Fetch a session, or explain why it isn't there.
 *
 * The owner check is belt and braces - these only ever render into ephemeral
 * messages, which nobody else can see or click - but a token is a capability
 * and it costs one comparison to keep it from being a shared one
 */
function getSession(token, slackUserId) {
  const session = sessions.get(token);
  if (!session) throw new UserFacingError(EXPIRED);
  if (slackUserId && session.slackUserId !== slackUserId) {
    throw new UserFacingError('That result set belongs to someone else.');
  }
  return session;
}

/** JSON, because a delimiter would eventually meet a space id containing it */
function packValue(payload) {
  return JSON.stringify(payload);
}

function unpackValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new UserFacingError(EXPIRED);
  }
}

/** Total pages for a session's items, never less than one */
function pageCount(session) {
  return Math.max(1, Math.ceil(session.items.length / config.sigma.pageSize));
}

/** Clamp a requested page and return its slice */
function pageOf(session, requested) {
  const total = pageCount(session);
  const page = Math.min(Math.max(1, Number(requested) || 1), total);
  const start = (page - 1) * config.sigma.pageSize;
  return {
    page,
    total,
    start,
    items: session.items.slice(start, start + config.sigma.pageSize),
  };
}

function clear() {
  sessions.clear();
}

module.exports = {
  EXPIRED,
  createSession,
  getSession,
  packValue,
  unpackValue,
  pageCount,
  pageOf,
  clear,
};