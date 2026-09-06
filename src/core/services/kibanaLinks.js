'use strict';

const config = require('../../../config');
const { DEFAULT_SPACE } = require('../constants');
const { isAbsoluteHttpUrl } = require('../util/url');

/*
 * Kibana URL construction.
 *
 * THIS STAYS IN CORE, and it is the one file in the migration where the
 * promotion rule points the other way from the folder name. `caseUrl` and
 * `caseLinkForIncident` are cases-only, but `ruleUrl` backs /sigma's "View rule"
 * link button. Two features, so it is core - splitting it would mean two copies
 * of the base-url-and-space-prefix logic, and the failure mode of getting that
 * wrong twice is a link that 404s or silently drops an analyst into the wrong
 * space.
 *
 * It moves from src/core/kibanaLinks.js to src/core/services/ so it sits with
 * spaceService and startService rather than loose at the top of core/. Two
 * requires in the tree point at the old path and one points at a
 * `./services/kibanaLinks` under features/cases that never existed.
 *
 * Everything here is built from config.elastic.kibanaPublicUrl (the endpoint an
 * analyst's *browser* reaches) rather than kibanaUrl (the endpoint Elastibot's
 * own HTTP client talks to). config falls the former back to the latter, so a
 * deployment that never set KIBANA_PUBLIC_URL still produces absolute links -
 * they just point at the internal hostname
 */

/** owner (Kibana solution) > the app path its cases live under */
const APP_PATH_BY_OWNER = Object.freeze({
  securitySolution: '/app/security/cases',
  observability: '/app/observability/cases',
});

/** Stack-management cases, for any owner that isn't a solution of its own */
const DEFAULT_APP_PATH = '/app/management/insightsAndAlerting/cases';

/**
 * Build a Kibana link to a case, respecting space + solution.
 *
 * @param {string} spaceId
 * @param {string} caseId
 * @param {string} owner  'securitySolution' | 'observability' | 'cases'
 */
function caseUrl(spaceId, caseId, owner) {
  const base = (config.elastic.kibanaPublicUrl || '').replace(/\/$/, '');
  const space = spaceId && spaceId !== DEFAULT_SPACE ? `/s/${encodeURIComponent(spaceId)}` : '';
  const appPath = APP_PATH_BY_OWNER[owner] || DEFAULT_APP_PATH;
  return `${base}${space}${appPath}/${encodeURIComponent(caseId)}`;
}

/**
 * The link to an incident record's case, or null if it has no case (or no way
 * to reach one).
 *
 * The record already holds everything the link is made of, so derive it and
 * treat the stored copy as a fast path rather than the source of truth. The
 * owner is stored per-record where available and falls back to the configured
 * default - a wrong-solution path is still a link an analyst can follow.
 *
 * @param {object} rec incident record from incidents.js
 * @returns {string|null}
 */
function caseLinkForIncident(rec) {
  if (!rec || !rec.caseId) return null;
  if (isAbsoluteHttpUrl(rec.caseLink)) return rec.caseLink;

  const built = caseUrl(rec.spaceId, rec.caseId, rec.caseOwner || config.elastic.defaultOwner);
  return isAbsoluteHttpUrl(built) ? built : null;
}

/**
 * Link to a detection rule's page in the Security app.
 *
 * Keyed on the rule's Kibana `id`, not its `rule_id` - the UI routes on the
 * former. This is the /sigma consumer that keeps this file in core.
 */
function ruleUrl(spaceId, id) {
  const base = (config.elastic.kibanaPublicUrl || '').replace(/\/$/, '');
  const space = spaceId && spaceId !== DEFAULT_SPACE ? `/s/${encodeURIComponent(spaceId)}` : '';
  return `${base}${space}/app/security/rules/id/${encodeURIComponent(id)}`;
}

module.exports = {
  caseUrl,
  caseLinkForIncident,
  ruleUrl,
  isAbsoluteHttpUrl,
  APP_PATH_BY_OWNER,
  DEFAULT_APP_PATH,
};