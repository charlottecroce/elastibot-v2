'use strict';

const {
  incidentMessage,
  identityLine,
  MAX_PENDING_IDS_SHOWN,
} = require('../src/services/incidentBlocks');
const { ACTIONS } = require('../src/constants');

/*
 * The incident message is the whole UI of this bot - three states, re-rendered
 * in place, and previously untested. Most of what follows is about the buttons,
 * because a button that renders but does nothing is invisible to every other
 * kind of check: Slack accepts the message, no error is logged, and the only
 * symptom is an analyst clicking and nothing happening
 */

const T0 = '2026-07-30T12:00:00.000Z';
const T1 = '2026-07-30T12:45:00.000Z';

function rec(over = {}) {
  return {
    key: 'incident-key-1',
    spaceId: 'default',
    spaceName: 'Security Operations',
    channel: 'C1',
    messageTs: '1700000000.000100',
    hostName: 'web-01',
    primaryUser: 'jsmith',
    userNames: ['jsmith'],
    alertIds: ['a1'],
    attachedIds: [],
    alertRules: { a1: 'Malware Detected' },
    ruleCounts: { 'Malware Detected': 1 },
    representativeRule: 'Malware Detected',
    topSeverity: 'high',
    from: T0,
    to: T0,
    caseId: null,
    caseLink: null,
    caseTitle: null,
    caseOwner: null,
    claim: null,
    ...over,
  };
}

/** A record whose case exists and whose link was stored normally */
function withCase(over = {}) {
  return rec({
    caseId: 'case-1',
    caseLink: 'https://kibana.example.com/app/security/cases/case-1',
    caseTitle: 'SO-073026-Malware Detected',
    caseOwner: 'securitySolution',
    attachedIds: ['a1'],
    ...over,
  });
}

const actionsOf = (blocks) => blocks.find((b) => b.type === 'actions');
const buttonWith = (blocks, actionId) =>
  (actionsOf(blocks)?.elements || []).find((e) => e.action_id === actionId);

/** The :open_file_folder: context line, which is the only route to the case */
const summaryTextOf = (blocks) =>
  blocks
    .flatMap((b) => b.elements || [])
    .map((e) => e.text)
    .find((t) => typeof t === 'string' && t.includes(':open_file_folder:'));

/** Every fenced block on the message, joined */
const fencesOf = (blocks) =>
  blocks
    .map((b) => b.text?.text)
    .filter((t) => typeof t === 'string' && t.includes('```'))
    .join('\n');

describe('state 1: no case yet', () => {
  test('offers Create case and nothing else', () => {
    const { blocks } = incidentMessage(rec(), ['a1']);
    const elements = actionsOf(blocks).elements;

    expect(elements).toHaveLength(1);
    expect(elements[0].action_id).toBe(ACTIONS.CREATE_CASE_FROM_ALERT);
    expect(elements[0].value).toBe('incident-key-1');
    expect(elements[0].style).toBe('primary');
  });

  test('a burst puts the count on the button', () => {
    const { blocks } = incidentMessage(
      rec({ alertIds: ['a1', 'a2', 'a3'], ruleCounts: { 'Malware Detected': 3 } }),
      ['a1', 'a2', 'a3']
    );
    expect(buttonWith(blocks, ACTIONS.CREATE_CASE_FROM_ALERT).text.text).toBe(
      'Create case (3 alerts)'
    );
  });

  test('no case means no case summary line', () => {
    const { blocks } = incidentMessage(rec(), ['a1']);
    expect(JSON.stringify(blocks)).not.toContain(':open_file_folder:');
  });

  test('no case means no /add_alert commands - there is no case to add to', () => {
    const { blocks } = incidentMessage(rec(), ['a1']);
    expect(JSON.stringify(blocks)).not.toContain('/add_alert');
  });
});

describe('state 2: case exists, everything attached', () => {
  test('there is nothing left to do, so there is no actions block', () => {
    // Slack rejects `elements: []` outright, so "no buttons" has to mean the
    // whole block is absent rather than an empty one
    const { blocks } = incidentMessage(withCase(), []);
    expect(actionsOf(blocks)).toBeUndefined();
  });

  test('the case summary line links the case title', () => {
    const { blocks } = incidentMessage(withCase(), []);
    const summary = JSON.stringify(blocks);
    expect(summary).toContain(
      '<https://kibana.example.com/app/security/cases/case-1|SO-073026-Malware Detected>'
    );
    expect(summary).toContain('1 of 1 alert attached');
  });

  test('nothing pending means no pending section', () => {
    const { blocks } = incidentMessage(withCase(), []);
    expect(blocks.some((b) => b.type === 'divider')).toBe(false);
    expect(JSON.stringify(blocks)).not.toContain('since the case was created');
  });
});

describe('state 3: case exists with pending alerts', () => {
  const pending = withCase({
    alertIds: ['a1', 'a2', 'a3'],
    attachedIds: ['a1'],
    ruleCounts: { 'Malware Detected': 2, Beaconing: 1 },
    to: T1,
  });

  test('offers Add alerts and nothing else', () => {
    const { blocks } = incidentMessage(pending, ['a2', 'a3']);
    const elements = actionsOf(blocks).elements;

    expect(elements).toHaveLength(1);
    expect(elements[0].action_id).toBe(ACTIONS.ADD_ALERTS_TO_CASE);
    expect(elements[0].text.text).toBe('Add 2 new alerts to case');
    expect(elements[0].value).toBe('incident-key-1');
  });

  test('one pending alert is singular', () => {
    const { blocks } = incidentMessage(pending, ['a2']);
    expect(buttonWith(blocks, ACTIONS.ADD_ALERTS_TO_CASE).text.text).toBe(
      'Add 1 new alert to case'
    );
    expect(JSON.stringify(blocks)).toContain('1 new alert since the case was created');
  });

  /*
   * The pending list is what gets used when the button fails, so it carries
   * whole commands rather than bare ids - assembling
   * `/add_alert <caseID> <alertID>` by hand around a UUID is how the wrong
   * alert ends up on the case
   */
  test('the pending ids come out as runnable commands, not bare ids', () => {
    const { blocks } = incidentMessage(pending, ['a2', 'a3']);
    const fence = fencesOf(blocks);

    expect(fence).toContain('/add_alert case-1 a2');
    expect(fence).toContain('/add_alert case-1 a3');
  });

  test('the commands sit in a fence, so a copy gets the commands and nothing else', () => {
    const { blocks } = incidentMessage(pending, ['a2', 'a3']);
    const fenced = blocks.find((b) => b.text?.text?.startsWith('```'));

    expect(fenced).toBeDefined();
    expect(fenced.type).toBe('section'); // context renders small and wraps mid-id
    expect(fenced.text.text).toBe('```\n/add_alert case-1 a2\n/add_alert case-1 a3\n```');
  });

  test('a backtick in an id cannot close the fence early', () => {
    const { blocks } = incidentMessage(pending, ['a2`whoami`']);
    const fenced = blocks.find((b) => b.text?.text?.startsWith('```'));

    // Three at the front, three at the back, none in the middle
    expect(fenced.text.text.match(/```/g)).toHaveLength(2);
    expect(fenced.text.text).toContain('/add_alert case-1 a2whoami');
  });

  test('a long pending list is capped and says how many are hidden', () => {
    const ids = Array.from({ length: MAX_PENDING_IDS_SHOWN + 4 }, (_, i) => `p${i}`);
    const { blocks } = incidentMessage(pending, ids);
    const text = JSON.stringify(blocks);

    expect(text).toContain(`/add_alert case-1 p${MAX_PENDING_IDS_SHOWN - 1}`);
    expect(text).not.toContain(`/add_alert case-1 p${MAX_PENDING_IDS_SHOWN}`);
    expect(text).toContain('+4 more');
  });

  test('the fence stays inside the 3000 char cap Slack puts on a section', () => {
    // Real ids are UUID-length; MAX_PENDING_IDS_SHOWN is what keeps this true
    const ids = Array.from({ length: MAX_PENDING_IDS_SHOWN }, () => 'f'.repeat(40));
    const { blocks } = incidentMessage(pending, ids);
    const fenced = blocks.find((b) => b.text?.text?.startsWith('```'));

    expect(fenced.text.text.length).toBeLessThanOrEqual(3000);
  });

  test('the pending breakdown is rendered when supplied', () => {
    const { blocks } = incidentMessage(pending, ['a2', 'a3'], {
      pendingRuleCounts: { Beaconing: 1, 'Malware Detected': 1 },
    });
    expect(JSON.stringify(blocks)).toContain('Beaconing ×1');
  });
});

/*
 * There is no "View case" button any more - see services/incidentBlocks.js for
 * why. The case summary line is now the only route from the message to the
 * case, so what used to be asserted about the button's url is asserted about
 * that link instead. rec.caseLink is a denormalised copy; these are the ways it
 * goes missing
 */
describe('the case summary link is always real', () => {
  test('a record with no stored link still gets a real url', () => {
    const { blocks } = incidentMessage(withCase({ caseLink: null }), []);
    expect(summaryTextOf(blocks)).toContain(
      '<https://kibana.example.com/app/security/cases/case-1|'
    );
  });

  test('a relative stored link is replaced with an absolute one', () => {
    const { blocks } = incidentMessage(
      withCase({ caseLink: '/app/security/cases/case-1' }),
      []
    );
    expect(summaryTextOf(blocks)).toContain(
      '<https://kibana.example.com/app/security/cases/case-1|'
    );
  });

  test('a non-default space is carried into the derived link', () => {
    const { blocks } = incidentMessage(withCase({ caseLink: undefined, spaceId: 'soc' }), []);
    expect(summaryTextOf(blocks)).toContain(
      '<https://kibana.example.com/s/soc/app/security/cases/case-1|'
    );
  });

  test('the owner picks the solution app when the link has to be derived', () => {
    const { blocks } = incidentMessage(
      withCase({ caseLink: null, caseOwner: 'observability' }),
      []
    );
    expect(summaryTextOf(blocks)).toContain('/app/observability/cases/');
  });

  test('the link is either absolute or absent - never a half-built one', () => {
    for (const link of [null, undefined, '', 'not a url', '/relative']) {
      const summary = summaryTextOf(incidentMessage(withCase({ caseLink: link }), []).blocks);
      const url = summary.match(/<([^|]+)\|/)?.[1];
      if (url) expect(url).toMatch(/^https?:\/\//);
      expect(summary).not.toContain('undefined');
    }
  });

  test('no view-case button is emitted in any state', () => {
    for (const r of [rec(), withCase(), withCase({ attachedIds: [] })]) {
      const { blocks } = incidentMessage(r, ['a1']);
      const text = JSON.stringify(blocks);
      expect(text).not.toContain('view_case');
      expect(text).not.toContain('View case');
      // and nothing on the message is a url button at all
      for (const el of actionsOf(blocks)?.elements || []) {
        expect(el).not.toHaveProperty('url');
      }
    }
  });
});

describe('block shape Slack will accept', () => {
  test('an actions block is never emitted empty', () => {
    // Slack rejects elements: [] and the rejection fails the whole chat.update,
    // so one unrenderable button must not take the message with it
    for (const r of [rec(), withCase(), withCase({ attachedIds: [] })]) {
      const actions = actionsOf(incidentMessage(r, ['a1']).blocks);
      if (actions) expect(actions.elements.length).toBeGreaterThan(0);
    }
  });

  test('every block has a type and no element is undefined', () => {
    const { blocks } = incidentMessage(withCase({ alertIds: ['a1', 'a2'] }), ['a2']);
    for (const block of blocks) {
      expect(typeof block.type).toBe('string');
      for (const el of block.elements || []) expect(el).toBeDefined();
    }
  });

  test('there is always a text fallback for notifications', () => {
    expect(incidentMessage(rec(), ['a1']).text).toBe('New alert: Malware Detected');
    expect(incidentMessage(rec({ alertIds: ['a1', 'a2'] }), ['a1', 'a2']).text).toBe(
      '2 related alerts on web-01: Malware Detected'
    );
  });

  test('a record with no alerts does not blow up on alertIds[0]', () => {
    expect(() => incidentMessage(rec({ alertIds: [] }), [])).not.toThrow();
  });
});

describe('escaping and identities', () => {
  test('a hostile host name cannot inject mrkdwn', () => {
    const { blocks } = incidentMessage(rec({ hostName: '<script>&' }), ['a1']);
    const text = JSON.stringify(blocks);
    expect(text).toContain('&lt;script&gt;&amp;');
    expect(text).not.toContain('<script>');
  });

  test('a rule name with an ampersand is escaped in the breakdown', () => {
    const { blocks } = incidentMessage(
      rec({ ruleCounts: { 'R&D Exfil': 2 }, representativeRule: 'R&D Exfil' }),
      ['a1']
    );
    expect(JSON.stringify(blocks)).toContain('R&amp;D Exfil ×2');
  });

  test('the rule breakdown is ordered by count, so a re-render does not reshuffle', () => {
    const { blocks } = incidentMessage(
      rec({ ruleCounts: { Beaconing: 1, Malware: 5, Persistence: 3 } }),
      ['a1']
    );
    const rules = blocks
      .flatMap((b) => b.elements || [])
      .map((e) => e.text)
      .find((t) => t && t.startsWith('*Rules:*'));
    expect(rules).toBe('*Rules:* Malware ×5, Persistence ×3, Beaconing ×1');
  });

  test('folded-in machine identities are shown next to the primary user', () => {
    expect(identityLine({ primaryUser: 'jsmith', userNames: ['jsmith', 'SYSTEM'] })).toBe(
      '`jsmith` _(+SYSTEM)_'
    );
  });

  test('an incident with no identity at all renders no user line', () => {
    expect(identityLine({ primaryUser: null, userNames: [] })).toBeNull();
  });

  test('a machine-only incident says so rather than showing a blank', () => {
    expect(identityLine({ primaryUser: null, userNames: ['SYSTEM'] })).toBe(
      '_no user_ _(+SYSTEM)_'
    );
  });
});

describe('the in-flight claim footer', () => {
  test('names whoever is mid-click', () => {
    const { blocks } = incidentMessage(rec({ claim: { by: 'U123' } }), ['a1']);
    expect(JSON.stringify(blocks)).toContain('<@U123> is creating a case…');
  });

  test('is absent when nobody holds the claim', () => {
    expect(JSON.stringify(incidentMessage(rec(), ['a1']).blocks)).not.toContain(
      'is creating a case'
    );
  });
});