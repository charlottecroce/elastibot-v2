'use strict';

/*
 * Jest config
 *
 * setupFiles runs BEFORE any module is required, which matters: config.js reads
 * process.env at require time, and half the modules under test pull it in
 */

module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  clearMocks: true,
  collectCoverageFrom: ['src/**/*.js', 'config/**/*.js'],
  // Nothing here talks to a real cluster, so a slow test means a hung mock
  testTimeout: 10000,
};