'use strict';

const {
  caseUrl,
  caseLinkForIncident,
  isAbsoluteHttpUrl,
} = require('../src/services/kibanaLinks');

/*
 * caseUrl is the one people notice when it breaks (a link that 404s or bounces
 * an analyst through a login). caseLinkForIncident is the one nobody notices
 * when it breaks, because its failure mode is a button that renders fine and
 * does nothing
 *
 */

describe('caseUrl', () => {
  test('default space has no /s/ prefix', () => {
    expect(caseUrl('default', 'case-1', 'securitySolution')).toBe(
      'https://kibana.example.com/app/security/cases/case-1'
    );
  });

  test('non-default space is prefixed', () => {
    expect(caseUrl('soc', 'case-1', 'securitySolution')).toBe(
      'https://kibana.example.com/s/soc/app/security/cases/case-1'
    );
  });

  test('owner picks the solution app', () => {
    expect(caseUrl('default', 'c', 'observability')).toContain('/app/observability/cases/');
    expect(caseUrl('default', 'c', 'cases')).toContain(
      '/app/management/insightsAndAlerting/cases/'
    );
  });

  test('an unrecognised owner falls back to stack management rather than a broken path', () => {
    expect(caseUrl('default', 'c', 'somethingNew')).toContain(
      '/app/management/insightsAndAlerting/cases/'
    );
    expect(caseUrl('default', 'c', undefined)).toContain(
      '/app/management/insightsAndAlerting/cases/'
    );
  });

  test('space id and case id are url encoded', () => {
    expect(caseUrl('my space', 'a/b', 'securitySolution')).toBe(
      'https://kibana.example.com/s/my%20space/app/security/cases/a%2Fb'
    );
  });

  test('prefers KIBANA_PUBLIC_URL over KIBANA_URL', () => {
    expect(caseUrl('default', 'c', 'securitySolution')).toContain('kibana.example.com');
    expect(caseUrl('default', 'c', 'securitySolution')).not.toContain('kibana.internal');
  });

  test('a trailing slash on the base url does not double up', () => {
    const previous = process.env.KIBANA_PUBLIC_URL;
    process.env.KIBANA_PUBLIC_URL = 'https://kibana.example.com/';
    jest.resetModules();
    const fresh = require('../src/services/kibanaLinks');
    expect(fresh.caseUrl('default', 'c', 'securitySolution')).toBe(
      'https://kibana.example.com/app/security/cases/c'
    );
    process.env.KIBANA_PUBLIC_URL = previous;
    jest.resetModules();
  });

  test('every link it produces is absolute, which is what a Slack button needs', () => {
    expect(isAbsoluteHttpUrl(caseUrl('default', 'c', 'securitySolution'))).toBe(true);
    expect(isAbsoluteHttpUrl(caseUrl('soc', 'c/d', 'cases'))).toBe(true);
  });
});

describe('isAbsoluteHttpUrl', () => {
  test('accepts http and https', () => {
    expect(isAbsoluteHttpUrl('https://kibana.example.com/x')).toBe(true);
    expect(isAbsoluteHttpUrl('http://kibana.internal:5601/x')).toBe(true);
  });

  test('rejects everything Slack would silently drop', () => {
    for (const bad of [null, undefined, '', '   ', '/app/security/cases/c', 'kibana.example.com', 42]) {
      expect(isAbsoluteHttpUrl(bad)).toBe(false);
    }
  });

  test('rejects other schemes', () => {
    expect(isAbsoluteHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isAbsoluteHttpUrl('file:///etc/passwd')).toBe(false);
  });
});

describe('caseLinkForIncident', () => {
  const rec = (over = {}) => ({
    caseId: 'case-1',
    spaceId: 'default',
    caseOwner: 'securitySolution',
    caseLink: 'https://kibana.example.com/app/security/cases/case-1',
    ...over,
  });

  test('uses the stored link when it is usable', () => {
    expect(caseLinkForIncident(rec({ caseLink: 'https://proxy.example.com/cases/case-1' }))).toBe(
      'https://proxy.example.com/cases/case-1'
    );
  });

  test('derives the link when the record never stored one', () => {
    // Records written by an earlier build survive in data/incidents.json, and
    // recordCase writes whatever `link` its result object happened to carry
    expect(caseLinkForIncident(rec({ caseLink: undefined }))).toBe(
      'https://kibana.example.com/app/security/cases/case-1'
    );
    expect(caseLinkForIncident(rec({ caseLink: null }))).toBe(
      'https://kibana.example.com/app/security/cases/case-1'
    );
  });

  test('replaces a stored link that is not absolute', () => {
    expect(caseLinkForIncident(rec({ caseLink: '/app/security/cases/case-1' }))).toBe(
      'https://kibana.example.com/app/security/cases/case-1'
    );
  });

  test('derives across spaces and owners', () => {
    expect(caseLinkForIncident(rec({ caseLink: null, spaceId: 'soc' }))).toBe(
      'https://kibana.example.com/s/soc/app/security/cases/case-1'
    );
    expect(
      caseLinkForIncident(rec({ caseLink: null, caseOwner: 'observability' }))
    ).toContain('/app/observability/cases/');
  });

  test('falls back to the configured default owner when the record has none', () => {
    // DEFAULT_CASE_OWNER is securitySolution in tests/setup.js
    expect(caseLinkForIncident(rec({ caseLink: null, caseOwner: null }))).toContain(
      '/app/security/cases/'
    );
  });

  test('no case means no link, rather than a link to nothing', () => {
    expect(caseLinkForIncident(rec({ caseId: null }))).toBeNull();
    expect(caseLinkForIncident(null)).toBeNull();
    expect(caseLinkForIncident(undefined)).toBeNull();
  });
});