'use strict';

/*
 * Jest config - the UNIT suite. `npm test`.
 *
 * setupFiles runs BEFORE any module is required, which matters: config/index.js
 * reads process.env at require time, and half the modules under test pull it in
 *
 * - see jest.integration.config.js for the integration suite.
 */

module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // testMatch is a glob over all of tests/, so the integration files have to be
  // excluded explicitly or `npm test` would try to run them with the unit
  // setup file and no cluster
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/integration/'],
  clearMocks: true,
  // app.js and scripts/ are included so the bootstrap and shutdown path shows up
  // as a real (currently low) number rather than being silently excluded
  collectCoverageFrom: ['src/**/*.js', 'config/**/*.js', 'app.js', 'scripts/**/*.js'],
  // Nothing here talks to a real cluster, so a slow test means a hung mock
  testTimeout: 10000,
};