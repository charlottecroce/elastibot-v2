'use strict';

/*
 * Deterministic config for the test run
 *
 */

process.env.KIBANA_URL = 'https://kibana.internal:5601';
process.env.KIBANA_PUBLIC_URL = 'https://kibana.example.com';
process.env.ELASTICSEARCH_URL = 'https://es.internal:9200';
process.env.ELASTIC_TLS_REJECT_UNAUTHORIZED = 'true';
process.env.ALERTS_INDEX = '.alerts-security.alerts-*';
process.env.DEFAULT_CASE_OWNER = 'securitySolution';

// No service key: keeps elastic.js from building a serviceClient on import
delete process.env.ELASTIC_SERVICE_API_KEY;

process.env.STATS_TIMEZONE = 'UTC';
process.env.STATS_DEFAULT_WINDOW = '7d';
process.env.STATS_MAX_WINDOW_DAYS = '90';
process.env.STATS_TOP_N = '10';
process.env.STATS_NOISE_MIN_ALERTS = '10';