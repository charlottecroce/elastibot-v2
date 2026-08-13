'use strict';

/*
 * Runs in each worker BEFORE any module is required: config/index.js
 * reads its settings at require time and src/elastic.js builds its HTTPS agent
 * from them at require time too.
 *
 * config/loader.js ignores ./elastibot.yml under NODE_ENV=test, so whatever
 * config a developer has sitting in the repo root can't leak in here. These
 * env vars are the only source of settings for the integration run.
 *
 * These are set as real environment variables, which is the override path
 * config/index.js keeps for containers. There is no .env involved.
 */

const env = require('./env');

const set = (name, value) => {
  process.env[name] = String(value);
};

// --- what the tests actually point at ---
set('ELASTICSEARCH_URL', env.esUrl);
set('KIBANA_URL', env.kibanaUrl);
set('KIBANA_PUBLIC_URL', env.kibanaUrl);
set('ALERTS_INDEX', env.alertsIndex);
set('ELASTIC_TLS_REJECT_UNAUTHORIZED', 'true'); // the test stack is plain http
set('ELASTIC_SERVICE_API_KEY', process.env.ELASTIBOT_TEST_API_KEY || '');

// One retry, not two. A genuinely broken query shouldn't take three round
// trips to say so, but a single-node cluster does briefly 503 while a new
// index allocates, and zero retries makes that flaky
set('ELASTIC_RETRIES', '1');
set('ELASTIC_RETRY_BASE_MS', '100');
set('ELASTIC_TIMEOUT_MS', '20000');

// --- things that must be present for config to validate, but aren't used ---
set('SLACK_BOT_TOKEN', 'xoxb-integration');
set('SLACK_SIGNING_SECRET', 'integration');
set('SLACK_APP_TOKEN', 'xapp-integration');
set('ELASTIBOT_SECRET_KEY', 'integration-secret-key-0123456789abcdef');

// Nothing should be polling anything during a test run
set('WATCHERS_ENABLED', 'false');

// --- pinned so assertions can be exact ---
set('STATS_TIMEZONE', 'UTC');
set('STATS_TOP_N', '10');
set('STATS_NOISE_MIN_ALERTS', '1');
set('STATS_PROCESS_FIELD', 'process.name');
set('CASE_TITLE_TIMEZONE', 'UTC');

set('LOG_LEVEL', process.env.ELASTIBOT_TEST_LOG_LEVEL || 'silent');