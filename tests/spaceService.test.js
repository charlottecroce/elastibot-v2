'use strict';

const { createSpaceService } = require('../src/services/spaceService');

/*
 * Space name resolution is cosmetic - it only ever affects a case title and a
 * Slack heading - so the important property is that it can never fail a case
 * creation. Everything here uses createSpaceService directly rather than the
 * module-level shared instance, so nothing leaks between tests
 */

describe('space service', () => {
  test('one lookup serves every caller for that space', async () => {
    const client = { getSpaceName: jest.fn().mockResolvedValue('Security Operations') };
    const spaces = createSpaceService({ ttlMs: 10000 });

    await Promise.all([
      spaces.getName('soc', client),
      spaces.getName('soc', client),
    ]);
    await spaces.getName('soc', client);

    expect(client.getSpaceName).toHaveBeenCalledTimes(1);
  });

  test('a lookup failure falls back to the id and does not throw', async () => {
    const client = { getSpaceName: jest.fn().mockRejectedValue(new Error('kibana down')) };
    const spaces = createSpaceService({ ttlMs: 10000 });
    await expect(spaces.getName('soc', client)).resolves.toBe('soc');
  });

  test('invalidate forces a re-read after a rename', async () => {
    const client = {
      getSpaceName: jest.fn()
        .mockResolvedValueOnce('Old Name')
        .mockResolvedValueOnce('New Name'),
    };
    const spaces = createSpaceService({ ttlMs: 10000 });

    expect(await spaces.getName('soc', client)).toBe('Old Name');
    spaces.invalidate('soc');
    expect(await spaces.getName('soc', client)).toBe('New Name');
  });
});