'use strict';

/*
 * tests/testenv.js - every variable the test suites read
 *
 * The two suites (unit/integration) still differ on a number of settings, and they differ on
 * purpose - see the comments on each. The point of putting them side by side
 * is that the difference is now easily visible and all in one place
 *
 * A note on why the env maps are functions rather than plain objects: some
 * values are read out of process.env at call time (the minted API key, the log
 * level override). globalSetup.js requires this module before the key exists,
 * so a map built at require time would capture an empty string and cache it
 * for the rest of the run.
 */

/* ---------------------------------------------------------------------------
 * The live stack - integration suite only
 *
 * Non-default ports (9201/5602) are deliberate. The integration suite deletes
 * every index matching its pattern before it runs, and doing that to a real
 * cluster someone left on 9200 would be a very bad day.
 *
 * scripts/test-stack.sh reads these values out of this file rather than
 * re-declaring them, so the ports and the password have one definition.
 * docker-compose.test.yml gets them from the environment the script exports;
 * its own `:-9201` style fallbacks are a backstop for running compose by hand.
 * ------------------------------------------------------------------------ */
const stack = {
  esPort: process.env.ELASTIC_TEST_ES_PORT || '9201',
  kibanaPort: process.env.ELASTIC_TEST_KIBANA_PORT || '5602',
  username: process.env.ELASTIC_TEST_USERNAME || 'elastic',
  password: process.env.ELASTIC_TEST_PASSWORD || 'elastibot-test',
  stackVersion: process.env.ELASTIC_STACK_VERSION || '8.15.3',
};

// Point these somewhere else to run against a stack you manage yourself
stack.esUrl = process.env.ELASTIC_TEST_ES_URL || `http://localhost:${stack.esPort}`;
stack.kibanaUrl = process.env.ELASTIC_TEST_KIBANA_URL || `http://localhost:${stack.kibanaPort}`;

/** Set by globalSetup once it has confirmed Kibana is actually there */
stack.hasKibana = () => process.env.ELASTIBOT_TEST_KIBANA_UP === '1';

/* ---------------------------------------------------------------------------
 * Endpoints the unit suite only pretends to talk to
 *
 * Nothing resolves these. They exist because config validation requires a
 * URL-shaped string, and because a handful of assertions check that a Slack
 * link was built from kibana_public_url and not from kibana_url - which only
 * proves anything if the two are visibly different.
 * ------------------------------------------------------------------------ */
const fakeStack = {
  kibanaUrl: 'https://kibana.internal:5601',
  kibanaPublicUrl: 'https://kibana.example.com',
  esUrl: 'https://es.internal:9200',
};

/* ---------------------------------------------------------------------------
 * Index patterns
 *
 * The unit suite pins the real pattern because that is what the query builders
 * are asserted against. The integration suite cannot: `.alerts-*` are system
 * indices in Elastic 8 and writing to them directly is restricted, so it uses
 * its own pattern with the same mappings - which is exactly why
 * elastic.alerts_index is a setting in the first place.
 * ------------------------------------------------------------------------ */
const indices = {
  prodPattern: '.alerts-security.alerts-*',
  testPrefix: 'test-alerts-security-',
};

indices.testPattern = `${indices.testPrefix}*`;

/**
 * Backing index n, in the six-digit form ILM rollover produces. The rollover
 * tests in elasticClient.test.js need more than one, and spelling
 * 'test-alerts-security-000002' into a test is how the pattern and the indices
 * it is supposed to match drift apart.
 */
indices.backingIndex = (n) => `${indices.testPrefix}${String(n).padStart(6, '0')}`;

indices.writeIndex = indices.backingIndex(1);

/* ---------------------------------------------------------------------------
 * Placeholder credentials
 *
 * None of these authenticate against anything. They exist so that
 * config/validate.js has something to accept for the required settings; the
 * integration suite boots the real config path and would otherwise fail
 * validation before reaching a single test.
 *
 * The unit suite deliberately does NOT set these - several tests assert on the
 * unconfigured path. Adding them here would break those quietly.
 * ------------------------------------------------------------------------ */
const credentials = {
  slackBotToken: 'xoxb-test-not-a-real-token',
  slackSigningSecret: 'test-signing-secret',
  slackAppToken: 'xapp-test-not-a-real-token',
  // 32+ chars or the at-rest encryption refuses to initialise
  encryptionKey: 'test-secret-key-0123456789abcdef',
};

/* ---------------------------------------------------------------------------
 * Fixture defaults
 *
 * The default shape of an alert document, used by makeAlert() in
 * tests/integration/helpers/esFixtures.js. A test overrides whichever of these
 * it actually cares about and inherits the rest, so an assertion about, say,
 * host rollups doesn't have to restate a rule name to be readable.
 * ------------------------------------------------------------------------ */
const fixtures = {
  alert: {
    spaceId: 'default',
    rule: 'Malware Detected',
    ruleUuid: 'rule-uuid-a',
    consumer: 'siem',
    severity: 'high',
    riskScore: 47,
    host: 'WEB-01',
    user: 'jsmith',
    process: 'powershell.exe',
    action: 'process_start',
  },
};

/* ---------------------------------------------------------------------------
 * The env maps
 *
 * Keys are environment variable names, exactly as config/index.js names them.
 * A null value means "make sure this is unset" rather than "set it to empty".
 * ------------------------------------------------------------------------ */

/** Settings both suites pin to the same value */
const shared = () => ({
  // No TLS is involved either way - the unit suite never connects and the test
  // stack is plain http - but leaving it at the default keeps the suites from
  // being the only place the insecure setting is exercised
  ELASTIC_TLS_REJECT_UNAUTHORIZED: 'true',

  // Pinned so date bucketing assertions can be exact regardless of the
  // developer's machine. naming.timeZone falls back to stats.timeZone, so
  // setting both to UTC is belt and braces rather than a behaviour change
  STATS_TIMEZONE: 'UTC',
  CASE_TITLE_TIMEZONE: 'UTC',

  STATS_TOP_N: '10',
});

/** Unit suite - `npm test`. Nothing here talks to anything */
const unitEnv = () => ({
  ...shared(),

  KIBANA_URL: fakeStack.kibanaUrl,
  KIBANA_PUBLIC_URL: fakeStack.kibanaPublicUrl,
  ELASTICSEARCH_URL: fakeStack.esUrl,
  ALERTS_INDEX: indices.prodPattern,
  DEFAULT_CASE_OWNER: 'securitySolution',

  // Unset, not empty: a present key makes elastic.js build a serviceClient at
  // import time, which is a live HTTPS agent pointed at a host that isn't there
  ELASTIC_SERVICE_API_KEY: null,

  STATS_DEFAULT_WINDOW: '7d',
  STATS_MAX_WINDOW_DAYS: '90',
  // The production default. The integration suite lowers it to 1 because it
  // seeds far fewer documents than a real cluster holds
  STATS_NOISE_MIN_ALERTS: '10',

  GROUP_WINDOW_MS: '3600000',
  GROUP_MERGE_MACHINE_USERS: 'true',
  GROUP_MACHINE_USERS:
    'SYSTEM,LOCAL SERVICE,NETWORK SERVICE,LOCAL SYSTEM,root,daemon,nobody,svc_*,svc-*,sa_*,_*',

  INCIDENT_IDLE_MS: '28800000',
  INCIDENT_MAX_LIFETIME_MS: '86400000',
  INCIDENT_CLAIM_TTL_MS: '60000',
});

/** Integration suite - `npm run test:live`. Talks to a real cluster */
const integrationEnv = () => ({
  ...shared(),

  // --- what the tests actually point at ---
  ELASTICSEARCH_URL: stack.esUrl,
  KIBANA_URL: stack.kibanaUrl,
  KIBANA_PUBLIC_URL: stack.kibanaUrl,
  ALERTS_INDEX: indices.testPattern,
  // Minted by globalSetup.js, which is why this map is a function
  ELASTIC_SERVICE_API_KEY: process.env.ELASTIBOT_TEST_API_KEY || '',

  // One retry, not two. A genuinely broken query shouldn't take three round
  // trips to say so, but a single-node cluster does briefly 503 while a new
  // index allocates, and zero retries makes that flaky
  ELASTIC_RETRIES: '1',
  ELASTIC_RETRY_BASE_MS: '100',
  ELASTIC_TIMEOUT_MS: '20000',

  // --- required for config to validate, never actually used ---
  SLACK_BOT_TOKEN: credentials.slackBotToken,
  SLACK_SIGNING_SECRET: credentials.slackSigningSecret,
  SLACK_APP_TOKEN: credentials.slackAppToken,
  ELASTIBOT_SECRET_KEY: credentials.encryptionKey,

  // Nothing should be polling anything during a test run
  WATCHERS_ENABLED: 'false',

  // --- pinned so assertions can be exact ---
  // 1, not the production 10: these tests seed a couple of dozen documents and
  // every rule would otherwise fall below the noise floor
  STATS_NOISE_MIN_ALERTS: '1',
  STATS_PROCESS_FIELD: 'process.name',

  LOG_LEVEL: process.env.ELASTIBOT_TEST_LOG_LEVEL || 'silent',
});

/**
 * Write a map onto process.env. A null or undefined value deletes the variable
 * instead of setting it to the string "null".
 *
 * @param {Record<string, string|number|boolean|null>} vars
 */
function applyEnv(vars) {
  for (const [name, value] of Object.entries(vars)) {
    if (value === null || value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = String(value);
    }
  }
  return vars;
}

module.exports = {
  stack,
  fakeStack,
  indices,
  credentials,
  fixtures,
  shared,
  unitEnv,
  integrationEnv,
  applyEnv,
};