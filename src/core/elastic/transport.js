'use strict';

const https = require('https');
const axios = require('axios');
const config = require('../../../config');
const { installRetry } = require('../util/retry');
const { DEFAULT_SPACE } = require('../constants');

/*
 * Everything about HOW Elastibot talks to Elastic, and nothing about WHAT it
 * asks for.
 *
 * TLS, the keep-alive pool, request timeouts, the max-response-bytes guard, the
 * read-only retry policy and the space path scheme all live here because they
 * are properties of the connection rather than of any one endpoint, and because
 * a feature getting one of them subtly wrong - a write that retries, a response
 * with no size ceiling - is a failure mode nobody would notice until it mattered.
 *
 * A feature never builds a transport. It is handed a client (client.js) that
 * already has one.
 */

/*
 * One agent for the process. Built at require time from config, same as before
 * the split - tests/setup.js and tests/integration/setup.js both run before any
 * module is required precisely so this reads the settings they pinned.
 */
const agent = new https.Agent({
  rejectUnauthorized: config.elastic.tlsRejectUnauthorized,
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: config.elastic.maxSockets,
  maxFreeSockets: 10,
  timeout: config.elastic.requestTimeoutMs,
});

/** Settings shared by both axios instances */
function transportOptions() {
  return {
    timeout: config.elastic.requestTimeoutMs,
    httpsAgent: agent,
    maxContentLength: config.elastic.maxResponseBytes,
    maxBodyLength: config.elastic.maxResponseBytes,
  };
}

/**
 * The ES + Kibana axios pair for one API key.
 *
 * A single Elastic API key authenticates to BOTH, which is why they are built
 * together and why there is exactly one client per key rather than one per
 * service.
 */
function buildTransport(apiKey) {
  const shared = transportOptions();

  const es = axios.create({
    ...shared,
    baseURL: config.elastic.esUrl,
    headers: { Authorization: `ApiKey ${apiKey}`, 'Content-Type': 'application/json' },
  });

  const kib = axios.create({
    ...shared,
    baseURL: config.elastic.kibanaUrl,
    headers: {
      Authorization: `ApiKey ${apiKey}`,
      'Content-Type': 'application/json',
      'kbn-xsrf': 'elastibot', // required by Kibana for state-changing requests
    },
  });

  // Retries reads only - see util/retry.js. Writes are never retried; creating
  // a case twice is worse than failing once
  const retryOpts = {
    retries: config.elastic.retries,
    baseDelayMs: config.elastic.retryBaseDelayMs,
  };
  installRetry(es, { ...retryOpts, name: 'es' });
  installRetry(kib, { ...retryOpts, name: 'kibana' });

  return { es, kib };
}

/**
 * Space paths: the default space is un-prefixed, others use /s/<id>.
 *
 * Core owns this because getting it wrong does not fail - it succeeds against
 * the wrong space, which is the single most expensive mistake a feature could
 * make with a case or a detection rule.
 */
function spacePath(spaceId) {
  return spaceId && spaceId !== DEFAULT_SPACE ? `/s/${encodeURIComponent(spaceId)}` : '';
}

/**
 * A one-shot ES client authenticated with HTTP Basic rather than an API key.
 * Used only by provision.js - built fresh for that single request, never cached,
 * never reused, and the admin password never reaches buildTransport or anything
 * else that would keep it around.
 */
function buildBasicAuthEsClient(username, password) {
  if (!username || !password) {
    throw new Error('An admin username and password are required.');
  }

  return axios.create({
    ...transportOptions(),
    baseURL: config.elastic.esUrl,
    headers: { 'Content-Type': 'application/json' },
    // axios turns this into a Basic auth header itself - the credential is
    // never touched by our own code beyond this one call
    auth: { username, password },
  });
}

module.exports = { agent, buildTransport, buildBasicAuthEsClient, spacePath };