'use strict';

/*
 * Runs in each worker BEFORE any module is required: config/index.js reads its
 * settings at require time and src/elastic.js builds its HTTPS agent from them
 * at require time too.
 *
 * config/loader.js ignores ./elastibot.yml under NODE_ENV=test, so whatever
 * config a developer has sitting in the repo root can't leak in here. These
 * env vars are the only source of settings for the integration run.
 *
 * They are set as real environment variables, which is the override path
 * config/index.js keeps for containers. There is no .env involved.
 *
 * The values live in tests/testenv.js. integrationEnv() is called here rather
 * than imported as an object because ELASTIC_SERVICE_API_KEY comes from the
 * key globalSetup.js minted, which does not exist when that module is first
 * required.
 */

const { integrationEnv, applyEnv } = require('../testenv');

applyEnv(integrationEnv());