'use strict';

const { withClaim, claimRefusal } = require('../src/services/incidentClaim');


/** An IncidentStore stub that records what the wrapper did to it */
function fakeIncidents(claimResult) {
  return {
    tryClaim: jest.fn().mockReturnValue(claimResult),
    releaseClaim: jest.fn(),
  };
}

const granted = (rec = { key: 'C1.abc' }) => ({ ok: true, rec });

describe('withClaim', () => {
  test('runs the body with the claimed record and returns its value', async () => {
    const rec = { key: 'C1.abc', alertIds: ['a', 'b'] };
    const incidents = fakeIncidents(granted(rec));
    const fn = jest.fn().mockResolvedValue({ caseId: 'case-1' });

    const result = await withClaim(incidents, 'C1.abc', 'U1', fn, { allowExistingCase: true });

    expect(fn).toHaveBeenCalledWith(rec);
    expect(result).toEqual({ ok: true, value: { caseId: 'case-1' }, rec });
    // opts are passed through untouched - the add-alerts path depends on this
    expect(incidents.tryClaim).toHaveBeenCalledWith('C1.abc', 'U1', { allowExistingCase: true });
  });

  test('the claim is released on success, not just on failure', async () => {
    // The old version released only in the catch and relied on the body
    // happening to call recordCase. A body that returns without recording
    // anything left the incident wedged with nothing in the log to say why
    const incidents = fakeIncidents(granted());
    await withClaim(incidents, 'C1.abc', 'U1', async () => 'done');
    expect(incidents.releaseClaim).toHaveBeenCalledWith('C1.abc');
  });

  test('the claim is released when the body throws, and the error propagates', async () => {
    const incidents = fakeIncidents(granted());
    const boom = new Error('kibana said no');

    await expect(
      withClaim(incidents, 'C1.abc', 'U1', async () => {
        throw boom;
      })
    ).rejects.toBe(boom);

    expect(incidents.releaseClaim).toHaveBeenCalledWith('C1.abc');
  });

  test('a refused claim never runs the body and never releases', async () => {
    // Releasing here would steal the claim from whoever actually holds it
    const incidents = fakeIncidents({ ok: false, reason: 'claimed', rec: { claim: { by: 'U1' } } });
    const fn = jest.fn();

    const result = await withClaim(incidents, 'C1.abc', 'U2', fn);

    expect(fn).not.toHaveBeenCalled();
    expect(incidents.releaseClaim).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('claimed');
  });
});

describe('claimRefusal', () => {
  test('an existing case points at the case and the add-alerts button', () => {
    const text = claimRefusal({
      ok: false,
      reason: 'case_exists',
      rec: { caseId: 'case-1', caseLink: 'https://kibana/case-1' },
    });

    expect(text).toContain('https://kibana/case-1');
    expect(text).toContain('Add new alerts to case');
  });

  test('a live claim names the analyst holding it', () => {
    const text = claimRefusal({
      ok: false,
      reason: 'claimed',
      rec: { claim: { by: 'U0123' } },
    });

    expect(text).toContain('<@U0123>'); // renders as a mention, not a raw id
  });

  test('a reaped incident falls back to the manual command', () => {
    expect(claimRefusal({ ok: false, reason: 'gone', rec: null })).toContain('/case <alertID>');
  });

  test('an unrecognised reason degrades to the safe message instead of throwing', () => {
    // rec is null for anything the store could not find, so the fallback must
    // not touch it
    expect(() => claimRefusal({ ok: false, reason: 'something_new', rec: null })).not.toThrow();
  });
});