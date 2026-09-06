'use strict';

/*
 * Deterministic config for the unit run.
 *
 * setupFiles runs BEFORE any module is required, which is the whole point:
 * config/index.js reads process.env at require time and half the modules under
 * test pull it in.
 *
 * The values themselves live in tests/testenv.js, next to the integration
 * suite's, so the two can be compared without opening two files.
 */

const { unitEnv, applyEnv } = require('./testenv');

applyEnv(unitEnv());