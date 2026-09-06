'use strict';

const { extend } = require('../../core/elastic/client');

/*
 * The Kibana endpoints /sigma uses. Nothing else in the app calls any of them.
 *
 * Every method body is the one that used to be in src/elastic.js, with the
 * axios call replaced by client.request(). No behaviour changed: request()
 * returns the response body, which is what each of these already destructured
 * out and returned.
 *
 * getSpaces is here rather than in core next to getSpaceName, and that is a
 * judgement call worth stating out loud: it is a spaces endpoint, so it looks
 * like it belongs with the other one. But listing every space is only ever done
 * to build /sigma's space picker, and core already has the spaces call that has
 * two consumers. One consumer, so it stays in the feature. If a second feature
 * ever needs a space picker, that is when it moves.
 */

function sigmaEndpoints(client) {
  return extend(client, {
    /** Kibana spaces this API key can see */
    async getSpaces() {
      const data = await client.request('', 'GET', '/api/spaces/space');
      return (data || []).map((space) => ({ id: space.id, name: space.name || space.id }));
    },

    /** One page of detection rules in a space */
    async findDetectionRules(spaceId, { page = 1, perPage = 100 } = {}) {
      const data = await client.request(
        spaceId,
        'GET',
        '/api/detection_engine/rules/_find',
        undefined,
        { params: { page, per_page: perPage, sort_field: 'name', sort_order: 'asc' } }
      );
      return {
        page: data?.page,
        perPage: data?.perPage,
        total: data?.total ?? 0,
        data: data?.data || [],
      };
    },

    /**
     * One rule by its `rule_id` - the Sigma UUID - rather than its `id`, which
     * Kibana generates per install. Null when this space doesn't have it
     */
    async getDetectionRuleByRuleId(spaceId, ruleId) {
      try {
        const data = await client.request(
          spaceId,
          'GET',
          '/api/detection_engine/rules',
          undefined,
          { params: { rule_id: ruleId } }
        );
        return data || null;
      } catch (err) {
        if (err?.response?.status === 404) return null;
        throw err;
      }
    },

    /**
     * Merge fields into an existing rule.
     *
     * PATCH, not PUT, and that is the whole reason index patterns, exceptions,
     * highlighted fields and scheduling survive a sigma update: a field that
     * isn't in the body is left alone rather than cleared
     */
    patchDetectionRule(spaceId, patch) {
      return client.request(spaceId, 'PATCH', '/api/detection_engine/rules', patch);
    },

    /** Create a detection rule from a converted Sigma rule */
    createDetectionRule(spaceId, rule) {
      return client.request(spaceId, 'POST', '/api/detection_engine/rules', rule);
    },
  });
}

module.exports = { sigmaEndpoints };