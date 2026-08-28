'use strict';

const config = require('../../config');
const { createPager, packValue, unpackValue: unpack } = require('../util/pager');

/*
 * /sigma's paged result sets.
 *
 * The mechanism lives in util/pager. This file is only the sigma-shaped
 * instance of it: the settings stay next to the feature they belong to, and the
 * next module that needs paging calls createPager with its own TTL and page
 * size instead of sharing these.
 *
 * Why a cache at all: a page button could carry everything needed to rebuild
 * its page, but /sigma update is a full sweep of every detection rule in a
 * space diffed against the database, and redoing that on every "next" click
 * would make paging cost more than the command did
 */

const EXPIRED = 'That result set has expired. Run the command again.';

const pager = createPager({
  ttlMs: config.sigma.sessionTtlMs,
  max: config.sigma.maxSessions,
  pageSize: config.sigma.pageSize,
  expiredMessage: EXPIRED,
});

const unpackValue = (value) => unpack(value, EXPIRED);

module.exports = {
  EXPIRED,
  createSession: pager.create,
  getSession: pager.get,
  pageCount: pager.pageCount,
  pageOf: pager.pageOf,
  itemAt: pager.itemAt,
  clear: pager.clear,
  packValue,
  unpackValue,
};