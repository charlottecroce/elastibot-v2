'use strict';

/*
 * Where the integration suite expects to find a cluster.
 *
 * Defaults match docker-compose.test.yml. Point ELASTIC_TEST_ES_URL somewhere
 * else to run against a stack you manage yourself.
 *
 * Non-default ports (9201/5602) are on purpose. These tests delete every index
 * matching the test pattern before they run, and doing that to a real
 * cluster someone left on 9200 would be a very bad day.
 */

const ES_PORT = process.env.ELASTIC_TEST_ES_PORT || '9201';
const KIBANA_PORT = process.env.ELASTIC_TEST_KIBANA_PORT || '5602';

module.exports = {
  esUrl: process.env.ELASTIC_TEST_ES_URL || `http://localhost:${ES_PORT}`,
  kibanaUrl: process.env.ELASTIC_TEST_KIBANA_URL || `http://localhost:${KIBANA_PORT}`,

  username: process.env.ELASTIC_TEST_USERNAME || 'elastic',
  password: process.env.ELASTIC_TEST_PASSWORD || 'elastibot-test',

  /*
   * NOT `.alerts-security.alerts-*`. Those are system indices in Elastic 8 and
   * writing to them directly is restricted, so the suite uses its own pattern
   * with the same mappings, which is exactly why elastic.alerts_index is a
   * setting in the first place
   */
  alertsIndex: 'test-alerts-security-*',
  writeIndex: 'test-alerts-security-000001',

  /** Set by globalSetup once it has confirmed Kibana is actually there */
  hasKibana: () => process.env.ELASTIBOT_TEST_KIBANA_UP === '1',
};