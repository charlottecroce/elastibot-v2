'use strict';

/*
 * Integration tests. These talk to a REAL Elasticsearch/Kibana - see scripts/test-stack.sh.
 *
 * Deliberately a separate config rather than a project in jest.config.js:
 * tests/setup.js mocks the world for the unit suite, and these need the
 * opposite. Keeping them apart is also what lets `npm test` stay a
 * no-dependencies, no-docker command. These tests are also not part of CI because they are slow and heavy
 *
 */

module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  globalSetup: '<rootDir>/tests/integration/globalSetup.js',
  globalTeardown: '<rootDir>/tests/integration/globalTeardown.js',
  setupFiles: ['<rootDir>/tests/integration/setup.js'],
  testMatch: ['<rootDir>/tests/integration/**/*.test.js'],
  clearMocks: true,

  /*
   * One worker. The suite shares one cluster and one index pattern, and
   * /stats aggregates over everything matching that pattern - parallel files
   * would see each other's documents and the counts would be nondeterministic.
   * There are few enough of these that the wall-clock cost is small
   */
  maxWorkers: 1,

  // A real cluster with a cold page cache is not a mock. The first search
  // after an index create can take a couple of seconds
  testTimeout: 60000,

  // Individual files are slow by nature here; only complain about the outliers
  slowTestThreshold: 15,
};