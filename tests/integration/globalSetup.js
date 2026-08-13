'use strict';

/*
 * Runs once, before any integration test file.
 *
 *   1. Confirm a cluster is actually there, and say something useful if not.
 *      A wall of ECONNREFUSED stack traces is a bad way to learn you forgot
 *      to start the stack.
 *   2. Delete anything left over from a previous run. The stack is reused
 *      between runs on purpose, so leftovers are the normal case, and
 *      /stats counts every document under the test index pattern, so leftovers
 *      would make its assertions drift.
 *   3. Mint the API key the tests authenticate with, and hand it to the
 *      workers through the environment.
 *
 * Note the ordering constraint this file creates: it runs BEFORE the workers
 * fork, and therefore before tests/integration/setup.js. That is why
 * testenv.integrationEnv() is a function - it reads ELASTIBOT_TEST_API_KEY,
 * which does not exist until step 3 below.
 */

const axios = require('axios');
const { stack, indices } = require('../testenv');

const ATTEMPTS = 30;
const GAP_MS = 2000;

const admin = () =>
  axios.create({
    baseURL: stack.esUrl,
    auth: { username: stack.username, password: stack.password },
    timeout: 10000,
    validateStatus: () => true,
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCluster(client) {
  let last;
  for (let i = 0; i < ATTEMPTS; i += 1) {
    try {
      const res = await client.get('/_cluster/health', {
        params: { wait_for_status: 'yellow', timeout: '5s' },
      });
      if (res.status === 200) return res.data;
      if (res.status === 401) {
        throw new Error(
          `Elasticsearch at ${stack.esUrl} rejected elastic/<ELASTIC_TEST_PASSWORD>. ` +
            'If you changed the password, run `npm run stack:reset` - the old one is ' +
            'baked into the data volume.'
        );
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      if (/rejected/.test(err.message)) throw err;
      last = err.code || err.message;
    }
    await sleep(GAP_MS);
  }

  throw new Error(
    `No Elasticsearch at ${stack.esUrl} after ${(ATTEMPTS * GAP_MS) / 1000}s (last: ${last}).\n\n` +
      '  npm run stack:up          start it\n' +
      '  npm run test:live         start it and run these tests\n' +
      '  npm run stack:status      see what is actually running\n\n' +
      'Or point ELASTIC_TEST_ES_URL at a cluster you already have.'
  );
}

async function probeKibana() {
  try {
    const res = await axios.get(`${stack.kibanaUrl}/api/status`, {
      timeout: 5000,
      validateStatus: () => true,
    });
    return res.status === 200 && res.data?.status?.overall?.level === 'available';
  } catch {
    return false;
  }
}

module.exports = async () => {
  const client = admin();
  const health = await waitForCluster(client);

  const info = await client.get('/');
  const version = info.data?.version?.number || 'unknown';

  // Leftovers from the last run. The stack is reused; the data is not
  const wipe = await client.delete(`/${encodeURIComponent(indices.testPattern)}`, {
    params: { ignore_unavailable: true, allow_no_indices: true },
  });
  if (wipe.status >= 400 && wipe.status !== 404) {
    throw new Error(
      `Could not clear ${indices.testPattern}: HTTP ${wipe.status} ` +
        `${JSON.stringify(wipe.data)}`
    );
  }

  /*
   * One key for the whole suite. No role_descriptors, so it inherits the
   * creating user's privileges. These tests are checking that our queries and
   * our client are right, not that Elastic's authorization works
   */
  const key = await client.post('/_security/api_key', {
    name: `elastibot-integration-${Date.now()}`,
    expiration: '1h',
  });
  if (key.status !== 200 && key.status !== 201) {
    throw new Error(`Could not create an API key: HTTP ${key.status} ${JSON.stringify(key.data)}`);
  }

  // globalSetup runs before the workers fork, so these reach every test file
  process.env.ELASTIBOT_TEST_API_KEY = key.data.encoded;
  process.env.ELASTIBOT_TEST_ES_VERSION = version;

  const kibanaUp = await probeKibana();
  process.env.ELASTIBOT_TEST_KIBANA_UP = kibanaUp ? '1' : '0';

  // eslint-disable-next-line no-console
  console.log(
    `\n  elasticsearch ${version} at ${stack.esUrl} (${health.status})` +
      `\n  kibana        ${kibanaUp ? stack.kibanaUrl : 'not running - those tests will skip'}\n`
  );
};