'use strict';

/*
 * The create-case-claim wrapper used by commands/case.js's button handlers,
 * plus the message shown to whichever analyst loses the race.
 *
 * Pulled out of the command module so that file stays what a command module is
 * supposed to be: registration only, same as commands/add_alert.js and
 * commands/stats.js use services/caseService.js and services/statsService.js
 *
 * See src/incidents.js for what the claim itself actually enforces - this is
 * just the try/release bookkeeping around it
 */

/**
 * Run `fn` while holding the create-case claim on an incident, releasing it on
 * any path out. The claim must be released or the incident is wedged for
 * claimTtlMs - Elastic failures are common enough that this matters
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
  } catch (err) {
    incidents.releaseClaim(key);
    throw err;
  }
}

/** The ephemeral message shown to an analyst whose claim attempt was refused */
function claimRefusal(claim) {
  if (claim.reason === 'case_exists') {
    return (
      `A case already exists for this incident: <${claim.rec.caseLink}|${claim.rec.caseId}>. ` +
      'The message has been refreshed — use *Add new alerts to case* if some alerts still need attaching.'
    );
  }
  if (claim.reason === 'claimed') {
    return `<@${claim.rec.claim.by}> is creating a case for this incident right now — give it a second.`;
  }
  return 'That incident is no longer tracked. Use `/case <alertID>` for the alert IDs on the message.';
}

module.exports = { withClaim, claimRefusal };