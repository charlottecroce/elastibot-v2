'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { IncidentStore } = require('../src/incidents');
const { makeGroup } = require('../src/grouping');

/*
 * The incident store is what makes a duplicate case impossible and what lets a
 * block kit be updated on a later poll tick. Most of these tests are about the
 * claim, because that is the part a race would break and a unit test is the
 * only place a race is cheap to provoke
 */

const T0 = '2026-07-30T12:00:00.000Z';
const HOUR = 3600000;

let dir;
let filePath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incidents-test-'));
  filePath = path.join(dir, 'incidents.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function alert(id, over = {}) {
  return {
    id,
    index: '.internal.alerts-security.alerts-default-000001',
    spaceId: 'default',
    ruleName: 'Rule A',
    severity: 'low',
    timestamp: T0,
    userName: 'jsmith',
    hostName: 'web-01',
    ...over,
  };
}

function store(over = {}) {
  return new IncidentStore({ filePath, idleMs: 8 * HOUR, maxLifetimeMs: 24 * HOUR, claimTtlMs: 60000, ...over });
}

/*
 * Open an incident and complete the post, as the watcher does. Kept as one
 * helper because a record without setMessage is a half-open state that only
 * the failed-post test cares about
 */
function open(s, alerts, { channel = 'C1', messageTs = '1700000000.000100' } = {}) {
  const rec = s.open({ group: makeGroup(alerts), channel, spaceName: 'Security Operations' });
  s.setMessage(rec.key, { channel, messageTs });
  return s.get(rec.key);
}

describe('opening and merging', () => {
  test('a new incident records the message and its alerts', () => {
    const s = store();
    const rec = open(s, [alert('a'), alert('b')]);

    expect(rec.channel).toBe('C1');
    expect(rec.messageTs).toBe('1700000000.000100');
    expect(rec.alertIds).toEqual(['a', 'b']);
    expect(rec.attachedIds).toEqual([]);
    expect(rec.caseId).toBeNull();
  });

  test('the key is safe to put on a Slack button', () => {
    const s = store();
    const rec = open(s, [alert('a')]);
    expect(rec.key).toMatch(/^[\x20-\x7e]+$/);
    expect(rec.key.length).toBeLessThan(2000);
  });

  test('the key exists before the message does, so buttons can be rendered', () => {
    // This is what lets an incident be posted in one API call instead of a
    // skeleton followed by an update
    const s = store();
    const rec = s.open({ group: makeGroup([alert('a')]), channel: 'C1', spaceName: 'd' });

    expect(rec.key).toBeTruthy();
    expect(rec.messageTs).toBeNull();
  });

  test('a record with no message is inert until setMessage', () => {
    // A failed post must not leave something findMatch will fold the next
    // tick's alerts into - they would land on a message that does not exist
    const s = store();
    s.open({ group: makeGroup([alert('a')]), channel: 'C1', spaceName: 'd' });

    expect(s.findMatch(makeGroup([alert('b')]))).toBeNull();
  });

  test('discard removes a record whose post failed', () => {
    const s = store();
    const rec = s.open({ group: makeGroup([alert('a')]), channel: 'C1', spaceName: 'd' });

    s.discard(rec.key);

    expect(s.get(rec.key)).toBeNull();
  });

  test('two incidents opened in the same millisecond get distinct keys', () => {
    const s = store();
    const a = s.open({ group: makeGroup([alert('a')]), channel: 'C1', spaceName: 'd' });
    const b = s.open({ group: makeGroup([alert('b', { hostName: 'web-02' })]), channel: 'C1', spaceName: 'd' });

    expect(a.key).not.toBe(b.key);
  });

  test('merging adds only the alerts that are new', () => {
    const s = store();
    const rec = open(s, [alert('a'), alert('b')]);

    const { addedIds } = s.merge(rec.key, makeGroup([alert('b'), alert('c')]));

    expect(addedIds).toEqual(['c']);
    expect(s.get(rec.key).alertIds).toEqual(['a', 'b', 'c']);
  });

  test('a merge that adds nothing is reported, so the caller can skip the update', () => {
    // Overlapping polls hit this constantly; a chat.update per tick with no
    // change is a rate limit waiting to happen
    const s = store();
    const rec = open(s, [alert('a')]);

    expect(s.merge(rec.key, makeGroup([alert('a')])).addedIds).toEqual([]);
  });

  test('severity ratchets up and never back down', () => {
    const s = store();
    const rec = open(s, [alert('a', { severity: 'critical' })]);

    s.merge(rec.key, makeGroup([alert('b', { severity: 'low' })]));

    expect(s.get(rec.key).topSeverity).toBe('critical');
  });

  test('rule counts accumulate across merges', () => {
    const s = store();
    const rec = open(s, [alert('a', { ruleName: 'Malware' })]);

    s.merge(rec.key, makeGroup([alert('b', { ruleName: 'Malware' })]));
    s.merge(rec.key, makeGroup([alert('c', { ruleName: 'Beaconing' })]));

    expect(s.get(rec.key).ruleCounts).toEqual({ Malware: 2, Beaconing: 1 });
    expect(s.get(rec.key).representativeRule).toBe('Malware');
  });

  test('rule counts always agree with the id list', () => {
    // Both derive from alertRules, so a re-delivered alert can't inflate the
    // breakdown past the number of alerts actually on the message
    const s = store();
    const rec = open(s, [alert('a', { ruleName: 'Malware' })]);

    s.merge(rec.key, makeGroup([alert('a', { ruleName: 'Malware' }), alert('b', { ruleName: 'Malware' })]));

    const got = s.get(rec.key);
    const total = Object.values(got.ruleCounts).reduce((n, c) => n + c, 0);
    expect(total).toBe(got.alertIds.length);
  });
});

describe('pending alerts', () => {
  test('pending is what the message shows minus what is on the case', () => {
    const s = store();
    const rec = open(s, [alert('a'), alert('b')]);

    s.recordCase(rec.key, { caseId: 'case-1', link: 'https://x', title: 'T' }, ['a', 'b']);
    expect(s.pending(s.get(rec.key))).toEqual([]);

    s.merge(rec.key, makeGroup([alert('c'), alert('d')]));
    expect(s.pending(s.get(rec.key))).toEqual(['c', 'd']);
  });

  test('alerts that failed to attach stay pending', () => {
    // recordCase is given the ids that actually attached, not the ids we asked
    // for. A partial attach that reported success would under-report pending
    const s = store();
    const rec = open(s, [alert('a'), alert('b'), alert('c')]);

    s.recordCase(rec.key, { caseId: 'case-1', link: 'https://x', title: 'T' }, ['a', 'b']);

    expect(s.pending(s.get(rec.key))).toEqual(['c']);
  });

  test('the pending breakdown covers alerts from every tick, not just the last', () => {
    // The bug this guards: the breakdown used to be built from whichever batch
    // triggered the render, so a pending alert left over from an earlier tick
    // was missing from the counts the analyst reads
    const s = store();
    const rec = open(s, [alert('a', { ruleName: 'Malware' })]);
    s.recordCase(rec.key, { caseId: 'case-1', link: 'https://x', title: 'T' }, ['a']);

    s.merge(rec.key, makeGroup([alert('b', { ruleName: 'Beaconing' })]));
    s.merge(rec.key, makeGroup([alert('c', { ruleName: 'Malware' })]));

    const got = s.get(rec.key);
    const pending = s.pending(got);
    expect(s.ruleCountsFor(got, pending)).toEqual({ Beaconing: 1, Malware: 1 });
  });

  test('recordAttached clears them', () => {
    const s = store();
    const rec = open(s, [alert('a'), alert('b')]);
    s.recordCase(rec.key, { caseId: 'case-1', link: 'https://x', title: 'T' }, ['a']);

    s.recordAttached(rec.key, ['b']);

    expect(s.pending(s.get(rec.key))).toEqual([]);
  });
});

describe('the create-case claim', () => {
  test('two analysts cannot both claim the same incident', () => {
    // This, not the button swap, is what makes a duplicate case impossible.
    // The button is still green on the second analyst's screen for the second
    // or so it takes the first click to reach Elastic
    const s = store();
    const rec = open(s, [alert('a')]);

    const first = s.tryClaim(rec.key, 'U1');
    const second = s.tryClaim(rec.key, 'U2');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('claimed');
    expect(second.rec.claim.by).toBe('U1');
  });

  test('a claim on an incident that already has a case is refused by reason', () => {
    const s = store();
    const rec = open(s, [alert('a')]);
    s.recordCase(rec.key, { caseId: 'case-1', link: 'https://x', title: 'T' }, ['a']);

    const claim = s.tryClaim(rec.key, 'U2');

    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe('case_exists');
  });

  test('allowExistingCase lets the add-alerts path claim', () => {
    // Adding alerts needs the mutual exclusion (Kibana's attach is not
    // idempotent) but an existing case is its precondition, not a refusal
    const s = store();
    const rec = open(s, [alert('a')]);
    s.recordCase(rec.key, { caseId: 'case-1', link: 'https://x', title: 'T' }, ['a']);

    expect(s.tryClaim(rec.key, 'U2', { allowExistingCase: true }).ok).toBe(true);
    expect(s.tryClaim(rec.key, 'U3', { allowExistingCase: true }).reason).toBe('claimed');
  });

  test('releasing lets the next analyst through', () => {
    const s = store();
    const rec = open(s, [alert('a')]);

    s.tryClaim(rec.key, 'U1');
    s.releaseClaim(rec.key);

    expect(s.tryClaim(rec.key, 'U2').ok).toBe(true);
  });

  test('an abandoned claim expires instead of wedging the incident', () => {
    const s = store({ claimTtlMs: 60000 });
    const rec = open(s, [alert('a')]);
    const t = Date.parse(T0);

    s.tryClaim(rec.key, 'U1', { now: t });

    expect(s.tryClaim(rec.key, 'U2', { now: t + 59000 }).ok).toBe(false);
    expect(s.tryClaim(rec.key, 'U2', { now: t + 61000 }).ok).toBe(true);
  });

  test('recordCase clears the claim', () => {
    const s = store();
    const rec = open(s, [alert('a')]);
    s.tryClaim(rec.key, 'U1');

    s.recordCase(rec.key, { caseId: 'case-1', link: 'https://x', title: 'T' }, ['a']);

    expect(s.get(rec.key).claim).toBeNull();
  });

  test('a claim on a reaped incident is refused rather than throwing', () => {
    const s = store();
    expect(s.tryClaim('C1.nope', 'U1')).toEqual({ ok: false, reason: 'gone', rec: null });
  });

  test('claims do not survive a restart', () => {
    // Nothing can be mid-creation at boot, so a claim on disk is from a process
    // that died holding it. Waiting out claimTtlMs would strand the incident
    const s = store();
    const rec = open(s, [alert('a')]);
    s.tryClaim(rec.key, 'U1');
    s.flush();

    const reopened = store();

    expect(reopened.get(rec.key).claim).toBeNull();
    expect(reopened.tryClaim(rec.key, 'U2').ok).toBe(true);
  });
});

describe('matching a new burst to an open incident', () => {
  test('same space and host with an overlapping identity matches', () => {
    const s = store();
    open(s, [alert('a')]);

    const match = s.findMatch(makeGroup([alert('b')]));

    expect(match).not.toBeNull();
    expect(match.alertIds).toEqual(['a']);
  });

  test('a machine-only burst joins the human incident on that host', () => {
    // The cross-poll half of the merge: SYSTEM alerts arriving a tick later
    // have to reach the message jsmith's alerts are already on
    const s = store();
    open(s, [alert('a')]);

    const match = s.findMatch(makeGroup([alert('s1', { userName: 'SYSTEM' })]));

    expect(match).not.toBeNull();
  });

  test('a different human on the same host does NOT match', () => {
    const s = store();
    open(s, [alert('a')]);

    expect(s.findMatch(makeGroup([alert('b', { userName: 'adoe' })]))).toBeNull();
  });

  test('a different host does not match', () => {
    const s = store();
    open(s, [alert('a')]);

    expect(s.findMatch(makeGroup([alert('b', { hostName: 'web-02' })]))).toBeNull();
  });

  test('a different space does not match', () => {
    const s = store();
    open(s, [alert('a')]);

    expect(s.findMatch(makeGroup([alert('b', { spaceId: 'soc' })]))).toBeNull();
  });

  test('a hostless burst never matches anything', () => {
    const s = store();
    open(s, [alert('a')]);

    expect(s.findMatch(makeGroup([alert('b', { hostName: undefined })]))).toBeNull();
  });

  test('an expired incident is not matched even before it is swept', () => {
    const s = store({ idleMs: HOUR });
    open(s, [alert('a')]);

    expect(s.findMatch(makeGroup([alert('b')]), Date.now() + 2 * HOUR)).toBeNull();
  });

  test('findByAlertId locates the incident showing an alert', () => {
    const s = store();
    const rec = open(s, [alert('a'), alert('b')]);

    expect(s.findByAlertId('b').key).toBe(rec.key);
    expect(s.findByAlertId('nope')).toBeNull();
  });
});

describe('reaping', () => {
  test('an idle incident is reaped', () => {
    const s = store({ idleMs: HOUR });
    const rec = open(s, [alert('a')]);

    expect(s.sweep(Date.now() + 2 * HOUR)).toBe(1);
    expect(s.get(rec.key)).toBeNull();
  });

  test('activity holds it open', () => {
    const s = store({ idleMs: HOUR });
    const rec = open(s, [alert('a')]);

    expect(s.sweep(Date.now() + 30 * 60000)).toBe(0);
    expect(s.get(rec.key)).not.toBeNull();
  });

  test('the lifetime cap reaps a still-active incident', () => {
    // Without it, a host trickling one alert every 7 hours builds one incident
    // that never ends and a case that grows without bound
    const s = store({ idleMs: 8 * HOUR, maxLifetimeMs: 24 * HOUR });
    const rec = open(s, [alert('a')]);

    s.merge(rec.key, makeGroup([alert('b')])); // still active

    expect(s.sweep(Date.now() + 25 * HOUR)).toBe(1);
  });

  test('records survive a restart', () => {
    const s = store();
    const rec = open(s, [alert('a')]);
    s.recordCase(rec.key, { caseId: 'case-1', link: 'https://x', title: 'T' }, ['a']);
    s.flush();

    const reopened = store();

    expect(reopened.get(rec.key).caseId).toBe('case-1');
    expect(reopened.get(rec.key).attachedIds).toEqual(['a']);
  });
});