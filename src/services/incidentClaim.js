'use strict';

/*
 * The create-case claim wrapper used by commands/case.js's button handlers,
 * plus the message shown to whichever analyst loses the race.
 *
 * See src/incidents.js for what the claim itself enforces - this is the
 * try/release bookkeeping around it.
 */

/**
 * Messages for every refusal reason tryClaim can return. Keeping them in a
 * table rather than an if/else chain means a new reason added to
 * incidents.tryClaim shows up here as a missing key rather than silently
 * falling through to the "no longer tracked" wording, which is what the old
 * trailing `return` did
 */
const REFUSALS = {
  case_exists: (rec) =>
    `A case already exists for this incident: <${rec.caseLink}|${rec.caseId}>. ` +
    'The message has been refreshed \u2014 use *Add new alerts to case* if some alerts ' +
    'still need attaching.',

  claimed: (rec) =>
    `<@${rec.claim.by}> is creating a case for this incident right now \u2014 give it a second.`,

  gone: () =>
    'That incident is no longer tracked. Use `/case <alertID>` for the alert IDs on the message.',
};

/**
 * Run `fn` while holding the create-case claim on an incident, releasing it on
 * every path out.
 *
 * The claim MUST be released or the incident is wedged for claimTtlMs, and
 * Elastic failures are common enough that this matters. The previous version
 * released only in the catch, relying on `fn` happening to call recordCase or
 * recordAttached (both of which clear the claim as a side effect) on the way
 * out. That held for the two handlers that existed, but made "did you remember
 * to record something?" a silent correctness requirement on every future
 * caller. Releasing in `finally` is a no-op when the record already cleared it.
 *
 * @param {object} incidents  IncidentStore
 * @param {string} key        incident key
 * @param {string} slackUserId
 * @param {function(object): Promise<*>} fn  runs with the claimed record
 * @param {object} [opts]  passed straight through to incidents.tryClaim
 * @returns {Promise<{ok:true,value:*,rec:object}|{ok:false,reason:string,rec:object|null}>}
 */
async function withClaim(incidents, key, slackUserId, fn, opts = {}) {
  const claim = incidents.tryClaim(key, slackUserId, opts);
  if (!claim.ok) return claim;

  try {
    return { ok: true, value: await fn(claim.rec), rec: claim.rec };
  } finally {
    incidents.releaseClaim(key);
  }
}

/** The ephemeral message shown to an analyst whose claim attempt was refused */
function claimRefusal(claim) {
  const message = REFUSALS[claim.reason] || REFUSALS.gone;
  return message(claim.rec);
}

module.exports = { withClaim, claimRefusal, REFUSALS };