'use strict';

const { buildTransport, spacePath } = require('./transport');
const { alertsPath, toAlert } = require('./alerts');

/*
 * The client every feature builds on.
 *
 * It knows how to make an authenticated, retried, timed-out, size-capped request
 * to Kibana or Elasticsearch, and it knows the two things that are genuinely
 * shared - the space name lookup and the alerts search. It knows no endpoints
 * beyond that, on purpose: adding a Kibana endpoint nobody anticipated should
 * mean writing a method in your own feature folder, not editing this file and
 * getting it reviewed by whoever owns core.
 *
 * ---------------------------------------------------------------------------
 * How a feature adds endpoints
 * ---------------------------------------------------------------------------
 *
 * `extend(client, methods)` returns a NEW object whose prototype is the core
 * client. Two properties fall out of that, and both matter:
 *
 *   - the cached core client is never mutated. It is shared by every feature
 *     for a given API key (that is the whole point of the TTL cache), so a
 *     feature that assigned its methods onto it would be handing its endpoints
 *     to every other feature and racing anyone doing the same.
 *
 *   - the feature's object still IS a core client. caseService can call
 *     `client.getSpaceName(...)` and `client.request(...)` on the thing it was
 *     given, without a passthrough layer in the feature that has to be kept in
 *     sync with core.
 *
 * So a feature's endpoints module looks like:
 *
 *   const { extend } = require('../../core/elastic/client');
 *
 *   function casesEndpoints(client) {
 *     return extend(client, {
 *       createCase: (spaceId, body) => client.request(spaceId, 'POST', '/api/cases', body),
 *     });
 *   }
 *
 * and the call site is `casesEndpoints(getClient(apiKey))`.
 */

/**
 * @param {string} apiKey
 * @returns {object} the core client
 */
function buildClient(apiKey) {
  if (!apiKey) throw new Error('An Elastic API key is required to build a client.');

  const { es, kib } = buildTransport(apiKey);

  /**
   * One Kibana request, space-scoped.
   *
   * Returns the response BODY, not the axios response - every existing call site
   * destructured `{ data }` and then only ever used `data`.
   *
   * Errors propagate as axios errors, untouched. describeAxiosError stays the
   * caller's job: it takes a context string ("Creating case", "Listing spaces")
   * that only the caller knows, and moving the translation in here would flatten
   * every one of those messages into the same sentence.
   *
   * @param {string} spaceId  '' or 'default' for the un-prefixed default space
   * @param {string} method   'GET' | 'POST' | 'PATCH' | ...
   * @param {string} path     e.g. '/api/cases'
   * @param {*} [body]
   * @param {object} [opts]
   * @param {object} [opts.params] query string. Needed because Kibana's _find
   *   endpoints are all GET-with-params and hand-encoding them into `path` in
   *   every feature is how you get one of them wrong
   */
  function request(spaceId, method, path, body, { params } = {}) {
    return kib
      .request({
        // LOWERCASE, deliberately: util/retry.js decides read-vs-write from
        // config.method, and every previous call site went through kib.get /
        // kib.post, which set it lowercase. Passing 'GET' through here would
        // quietly stop reads being retried.
        method: String(method).toLowerCase(),
        url: `${spacePath(spaceId)}${path}`,
        ...(body !== undefined ? { data: body } : {}),
        ...(params ? { params } : {}),
      })
      .then((res) => res.data);
  }

  /**
   * One Elasticsearch request. No space prefix - ES has no notion of one; a
   * space lives in the document as kibana.space_ids.
   */
  function esRequest(method, path, body) {
    return es
      .request({
        method: String(method).toLowerCase(),
        url: path,
        ...(body !== undefined ? { data: body } : {}),
      })
      .then((res) => res.data);
  }

  return {
    request,
    es: esRequest,

    /**
     * Search the configured alerts index. The raw ES response body, because
     * both consumers want different halves of it - cases wants hits, stats
     * wants aggregations.
     */
    searchAlerts(body) {
      return esRequest('POST', alertsPath, body);
    },

    /**
     * Kibana space display name.
     *
     * Not space-prefixed: the spaces API lives at the root and takes the id in
     * the path.
     *
     * Errors propagate on purpose. services/spaceService owns the fallback, so
     * that a real outage produces one warn line there instead of being silently
     * turned into a plausible-looking space id in two places
     */
    async getSpaceName(spaceId) {
      const data = await request('', 'GET', `/api/spaces/space/${encodeURIComponent(spaceId)}`);
      return data?.name || spaceId;
    },

    /** Exposed so a feature can map its own hits without importing core internals twice */
    toAlert,
  };
}

/**
 * Decorate a core client with a feature's endpoints, without touching it.
 *
 * @param {object} client a core client from buildClient/getClient
 * @param {object} methods the feature's endpoint functions
 * @returns {object} client-plus-methods
 */
function extend(client, methods) {
  return Object.assign(Object.create(client), methods);
}

module.exports = { buildClient, extend };