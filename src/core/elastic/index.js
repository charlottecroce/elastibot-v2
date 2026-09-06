'use strict';

const config = require('../../../config');
const { TtlCache } = require('../util/cache');
const { buildClient, extend } = require('./client');
const { buildBasicAuthEsClient } = require('./transport');
const { CURSOR_FIELD, alertsPath, field, ownerFromConsumer, toAlert } = require('./alerts');

/*
 * The public face of core's Elastic access. Features require THIS, never the
 * files under it.
 *
 * A single Elastic API key authenticates to both ES and Kibana, so there is one
 * client per key:
 *   - getClient(apiKey)          per-analyst (attributes cases to that user), cached
 *   - getServiceClient()         shared, uses the service key, for watchers
 *   - provisionAnalystApiKey()   one-shot, HTTP Basic with an admin credential
 *                                that is NEVER cached
 *
 * getClient replaces createElasticClient. The name changed because what it
 * returns changed: it is now the core primitive, not a client with every
 * feature's endpoints hanging off it. A feature turns it into something it can
 * use with its own endpoints module - see client.js.
 */

/*
 * Clients are cached per API key. The TTL bounds how long a revoked key keeps a
 * working client; the cap bounds memory. commands/start.js also invalidates
 * explicitly when an analyst re-registers, so a rotation takes effect at once
 *
 * The cache key is a secret. It stays in memory and is never logged - TtlCache
 * exposes `size`, never its keys
 */
const clientCache = new TtlCache({
  ttlMs: config.cache.clientTtlMs,
  max: config.cache.maxClients,
});

function getClient(apiKey) {
  if (!apiKey) throw new Error('An Elastic API key is required to build a client.');
  return clientCache.getOrCreate(apiKey, buildClient);
}

/** Drop a cached client. Called when an analyst re-registers with a new key */
function invalidateClient(apiKey) {
  return clientCache.delete(apiKey);
}

// Lazy service client for non-user operations (watchers, space lookups)
let _serviceClient;

function getServiceClient() {
  if (_serviceClient !== undefined) return _serviceClient;
  _serviceClient = config.elastic.serviceApiKey
    ? buildClient(config.elastic.serviceApiKey)
    : null;
  return _serviceClient;
}

/** Drop the cached service client, e.g. after a key rotation */
function resetServiceClient() {
  _serviceClient = undefined;
}

/**
 * Provision a brand new, narrowly-scoped Elastic API key for an analyst, using
 * an admin's Elastic username and password rather than an API key.
 *
 * This backs /start's "create one for me" option: a UAC-style prompt where an
 * analyst borrows an admin's credential for exactly one request instead of
 * copy-pasting a key out of Kibana themselves. The credential authenticates
 * over HTTP Basic straight to Elasticsearch's security API - it is never
 * stored, cached, or logged, and it never enters clientCache (which only ever
 * holds API-key-authenticated clients)
 *
 * Stays in core because /start is a core command: an analyst has to be able to
 * connect before any feature has anything to say to them.
 *
 * @param {string} adminUsername  an Elastic username with manage_api_key (or
 *   manage_own_api_key) - if it lacks that privilege, Elasticsearch rejects
 *   the request and this rejects too; nothing here grants any privilege itself
 * @param {string} adminPassword
 * @param {string} name           name for the new key, e.g. elastibot-jsmith
 * @returns {Promise<{id:string,name:string,apiKey:string}>} apiKey is the
 *   base64 "encoded" form, ready to hand straight to UserStore.set - the same
 *   shape an analyst would otherwise paste in by hand
 */
async function provisionAnalystApiKey(adminUsername, adminPassword, name) {
  const es = buildBasicAuthEsClient(adminUsername, adminPassword);
  const { data } = await es.post('/_security/api_key', {
    name,
    role_descriptors: config.elastic.analystRoleDescriptors,
  });
  return { id: data.id, name: data.name, apiKey: data.encoded };
}

module.exports = {
  // clients
  getClient,
  buildClient,
  invalidateClient,
  getServiceClient,
  resetServiceClient,
  provisionAnalystApiKey,

  // the helper a feature's endpoints module uses
  extend,

  // the alert document schema
  CURSOR_FIELD,
  alertsPath,
  field,
  ownerFromConsumer,
  toAlert,
};