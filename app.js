#!/usr/bin/env node
'use strict';

/*
 * Entry point.
 */

const { logger } = require('./src/core/util/logger');
const { main } = require('./src/core/app');

main().catch((err) => {
  logger.child({ scope: 'app' }).fatal('fatal startup error', { err });
  process.exit(1);
});