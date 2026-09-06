'use strict';

/*
 * The state a rule can be in relative to the selected space.
 *
 * Its own file so the Block Kit can render a state without requiring the
 * service that produces one. services/sigmaBlocks.js used to import STATE from
 * services/sigmaService.js, which dragged Elasticsearch and Prisma into a
 * module that only builds JSON - and made the layout impossible to test without
 * mocking both
 */

const STATE = Object.freeze({
  UNKNOWN: 'unknown', // not looked up yet - resolved lazily, one page at a time
  MISSING: 'missing', // not in the stack: offer Add
  OUTDATED: 'outdated', // in the stack and drifted: offer Update
  CURRENT: 'current', // in the stack and up to date: offer View
  BLOCKED: 'blocked', // in the stack but Elastic-managed: nothing we can do

  // Terminal states, set after a button is clicked. They keep the page honest
  // on re-render without another round trip to Elastic
  UPDATED: 'updated',
  ADDED: 'added',
  FAILED: 'failed',
});

module.exports = { STATE };