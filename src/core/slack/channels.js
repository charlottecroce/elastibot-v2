'use strict';

const config = require('../../../config');

/*
 * Which Slack channel an alert or a case from a given Elastic space goes to.
 *
 * Came out of the deleted src/core/watchers/index.js, which had to go: it
 * required pollAlerts and pollCases from this feature, so core could not boot
 * without cases installed and the eslint boundary refused it. The wiring it did
 * is now the feature loader's job; this routing rule is the one piece of it that
 * was actually cases-specific logic rather than wiring.
 *
 * An unrouted space resolves to '' rather than undefined. Both watchers treat ''
 * as "skip and count it"; undefined would read as a truthy-check bug at the call
 * site and there is a test pinning the distinction.
 */

function channelFor(spaceId) {
  return config.watchers.channelRouting[spaceId] || config.watchers.defaultChannel || '';
}

module.exports = { channelFor };