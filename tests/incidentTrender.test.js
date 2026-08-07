'use strict';

const { renderIncident, slackErrorCode, MESSAGE_GONE } = require('../src/services/incidentRender');

/*
 * renderIncident is the only place that puts an incident on screen, and both
 * the watcher and every button handler go through it.
 */

const KEY = 'incident-key-1';

function record(over = {}) {
  return {
    key: KEY,
    channel: 'C1',
    messageTs: '1700000000.000100',
    spaceId: 'default',
    spaceName: 'Security Operations',
    hostName: 'web-01',
    primaryUser: 'jsmith',
    userNames: ['jsmith'],
    alertIds: ['a1', 'a2'],
    attachedIds: ['a1'],
    ruleCounts: { Malware: 2 },
    representativeRule: 'Malware',
    topSeverity: 'high',
    from: '2026-07-30T12:00:00.000Z',
    to: '2026-07-30T12:30:00.000Z',
    caseId: 'case-1',
    caseLink: 'https://kibana.example.com/app/security/cases/case-1',
    caseTitle: 'SO-073026-Malware',
    caseOwner: 'securitySolution',
    claim: null,
    ...over,
  };
}

function fakeIncidents(rec) {
  return {
    get: jest.fn().mockReturnValue(rec),
    pending: jest.fn((r) => (r ? r.alertIds.filter((id) => !r.attachedIds.includes(id)) : [])),
    ruleCountsFor: jest.fn().mockReturnValue({ Malware: 1 }),
    setMessage: jest.fn((key, { channel, messageTs }) => ({ ...rec, channel, messageTs })),
  };
}

function fakeSlack(over = {}) {
  return {
    chat: {
      update: jest.fn().mockResolvedValue({ ok: true }),
      postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '1700000999.000200' }),
      ...over,
    },
  };
}

/** A Slack WebAPI error as Bolt surfaces it */
function slackError(code) {
  const err = new Error(`An API error occurred: ${code}`);
  err.data = { ok: false, error: code };
  return err;
}

describe('the happy path', () => {
  test('updates the existing message in place', async () => {
    const rec = record();
    const incidents = fakeIncidents(rec);
    const slack = fakeSlack();

    const out = await renderIncident(slack, incidents, KEY);

    expect(out).toBe(rec);
    expect(slack.chat.update).toHaveBeenCalledTimes(1);
    const arg = slack.chat.update.mock.calls[0][0];
    expect(arg.channel).toBe('C1');
    expect(arg.ts).toBe('1700000000.000100');
    expect(Array.isArray(arg.blocks)).toBe(true);
    expect(typeof arg.text).toBe('string');
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  test('the rendered message carries a clickable View case button', async () => {
    const incidents = fakeIncidents(record());
    const slack = fakeSlack();

    await renderIncident(slack, incidents, KEY);

    const { blocks } = slack.chat.update.mock.calls[0][0];
    const actions = blocks.find((b) => b.type === 'actions');
    const view = actions.elements.find((e) => e.text.text === 'View case');
    expect(view.url).toMatch(/^https:\/\//);
  });

  test('the pending breakdown comes off the record, not off the calling batch', async () => {
    const incidents = fakeIncidents(record());
    await renderIncident(fakeSlack(), incidents, KEY);

    expect(incidents.pending).toHaveBeenCalledWith(expect.objectContaining({ key: KEY }));
    expect(incidents.ruleCountsFor).toHaveBeenCalledWith(
      expect.objectContaining({ key: KEY }),
      ['a2']
    );
  });
});

describe('records that cannot be rendered', () => {
  test('a reaped incident renders nothing rather than throwing', async () => {
    const incidents = fakeIncidents(null);
    const slack = fakeSlack();

    await expect(renderIncident(slack, incidents, KEY)).resolves.toBeNull();
    expect(slack.chat.update).not.toHaveBeenCalled();
  });

  test('a record whose post never completed is skipped', async () => {
    // open() without setMessage - there is no message to update yet
    const incidents = fakeIncidents(record({ messageTs: null }));
    const slack = fakeSlack();

    await expect(renderIncident(slack, incidents, KEY)).resolves.toBeNull();
    expect(slack.chat.update).not.toHaveBeenCalled();
  });
});

describe('when the message has been deleted', () => {
  test('reposts and re-points the record at the new message', async () => {
    const incidents = fakeIncidents(record());
    const slack = fakeSlack({
      update: jest.fn().mockRejectedValue(slackError('message_not_found')),
    });

    const out = await renderIncident(slack, incidents, KEY, { repostIfGone: true });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage.mock.calls[0][0].channel).toBe('C1');
    expect(incidents.setMessage).toHaveBeenCalledWith(KEY, {
      channel: 'C1',
      messageTs: '1700000999.000200',
    });
    expect(out.messageTs).toBe('1700000999.000200');
  });

  test('a missing channel counts as gone too', async () => {
    const incidents = fakeIncidents(record());
    const slack = fakeSlack({
      update: jest.fn().mockRejectedValue(slackError('channel_not_found')),
    });

    await renderIncident(slack, incidents, KEY, { repostIfGone: true });
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  test('a button click does not repost - a click on a deleted message cannot happen', async () => {
    const incidents = fakeIncidents(record());
    const slack = fakeSlack({
      update: jest.fn().mockRejectedValue(slackError('message_not_found')),
    });

    await expect(renderIncident(slack, incidents, KEY)).resolves.toBeNull();
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(incidents.setMessage).not.toHaveBeenCalled();
  });
});

describe('other Slack failures', () => {
  test('are swallowed so a cosmetic re-render never fails the click that caused it', async () => {
    const incidents = fakeIncidents(record());
    const slack = fakeSlack({
      update: jest.fn().mockRejectedValue(slackError('ratelimited')),
    });

    await expect(renderIncident(slack, incidents, KEY)).resolves.toBeNull();
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  test('are not reposted even with repostIfGone - the message is still there', async () => {
    const incidents = fakeIncidents(record());
    const slack = fakeSlack({
      update: jest.fn().mockRejectedValue(slackError('invalid_blocks')),
    });

    await renderIncident(slack, incidents, KEY, { repostIfGone: true });
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('slackErrorCode', () => {
  test('reads the WebAPI shape and the transport shape', () => {
    expect(slackErrorCode(slackError('message_not_found'))).toBe('message_not_found');
    expect(slackErrorCode({ code: 'slack_webapi_platform_error' })).toBe(
      'slack_webapi_platform_error'
    );
  });

  test('is null for anything it cannot read, rather than throwing', () => {
    expect(slackErrorCode(new Error('boom'))).toBeNull();
    expect(slackErrorCode(null)).toBeNull();
    expect(slackErrorCode(undefined)).toBeNull();
  });

  test('MESSAGE_GONE is the set the repost branch keys off', () => {
    expect(MESSAGE_GONE.has('message_not_found')).toBe(true);
    expect(MESSAGE_GONE.has('ratelimited')).toBe(false);
  });
});