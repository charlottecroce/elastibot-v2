'use strict';

/*
 * Invalidate the suite's API key and leave.
 *
 * Note that this does NOT stop the stack. Reuse is the whole point, the
 * next run should be instant. `npm run stack:down` when you're done, or
 * `npm run stack:reset` to start from nothing.
 *
 * The test indices are not deleted here either. They're deleted at the START
 * of the next run instead, so that when something fails you can go and look at
 * what was actually indexed.
 */

const axios = require('axios');
const env = require('./env');

module.exports = async () => {
  const encoded = process.env.ELASTIBOT_TEST_API_KEY;
  if (!encoded) return;

  // Best effort. The key has a 1h expiry anyway, so a failure here is a tidiness
  // problem and not a reason to fail a run that otherwise passed
  try {
    const id = Buffer.from(encoded, 'base64').toString('utf8').split(':')[0];
    await axios.delete(`${env.esUrl}/_security/api_key`, {
      auth: { username: env.username, password: env.password },
      data: { ids: [id] },
      timeout: 5000,
      validateStatus: () => true,
    });
  } catch {
    /* ignore */
  }
};