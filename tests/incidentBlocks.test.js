'use strict';

const { incidentMessage, identityLine, MAX_PENDING_IDS_SHOWN } = require('../src/services/incidentBlocks');
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
});

describe('state 2: case exists, everything attached', () => {
  test('offers View case only', () => {
    const { blocks } = incidentMessage(withCase(), []);
    const elements = actionsOf(blocks).elements;

    expect(elements).toHaveLength(1);
    expect(elements[0].action_id).toBe(ACTIONS.VIEW_CASE);
    expect(elements[0].text.text).toBe('View case');
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

  test('offers View case and Add alerts, in that order', () => {
    const { blocks } = incidentMessage(pending, ['a2', 'a3']);
    const elements = actionsOf(blocks).elements;

    expect(elements.map((e) => e.action_id)).toEqual([
      ACTIONS.VIEW_CASE,
      ACTIONS.ADD_ALERTS_TO_CASE,
    ]);
    expect(elements[1].text.text).toBe('Add 2 new alerts to case');
    expect(elements[1].value).toBe('incident-key-1');
  });

  test('one pending alert is singular', () => {
    const { blocks } = incidentMessage(pending, ['a2']);
    expect(buttonWith(blocks, ACTIONS.ADD_ALERTS_TO_CASE).text.text).toBe(
      'Add 1 new alert to case'
    );
    expect(JSON.stringify(blocks)).toContain('1 new alert since the case was created');
  });

  test('the pending ids are listed so they can be reconciled by hand', () => {
    const { blocks } = incidentMessage(pending, ['a2', 'a3']);
    const text = JSON.stringify(blocks);
    expect(text).toContain('`a2`');
    expect(text).toContain('`a3`');
  });

  test('a long pending list is capped and says how many are hidden', () => {
    const ids = Array.from({ length: MAX_PENDING_IDS_SHOWN + 4 }, (_, i) => `p${i}`);
    const { blocks } = incidentMessage(pending, ids);
    const text = JSON.stringify(blocks);

    expect(text).toContain(`\`p${MAX_PENDING_IDS_SHOWN - 1}\``);
    expect(text).not.toContain(`\`p${MAX_PENDING_IDS_SHOWN}\``);
    expect(text).toContain('+4 more');
  });

  test('the pending breakdown is rendered when supplied', () => {
    const { blocks } = incidentMessage(pending, ['a2', 'a3'], {
      pendingRuleCounts: { Beaconing: 1, 'Malware Detected': 1 },
    });
    expect(JSON.stringify(blocks)).toContain('Beaconing ×1');
  });
});

/*
 * The regression this suite exists for. rec.caseLink is a denormalised copy;
 * these are the ways it goes missing, and in every one of them the button used
 * to render with url: undefined - clickable, and inert
 */
describe('View case is always a working link', () => {
  test('a record with no stored link still gets a real url', () => {
    const { blocks } = incidentMessage(withCase({ caseLink: null }), []);
    const button = buttonWith(blocks, ACTIONS.VIEW_CASE);

    expect(button).toBeDefined();
    expect(button.url).toBe('https://kibana.example.com/app/security/cases/case-1');
  });

  test('a relative stored link is replaced with an absolute one', () => {
    const { blocks } = incidentMessage(
      withCase({ caseLink: '/app/security/cases/case-1' }),
      []
    );
    expect(buttonWith(blocks, ACTIONS.VIEW_CASE).url).toBe(
      'https://kibana.example.com/app/security/cases/case-1'
    );
  });

  test('a non-default space is carried into the derived link', () => {
    const { blocks } = incidentMessage(
      withCase({ caseLink: undefined, spaceId: 'soc' }),
      []
    );
    expect(buttonWith(blocks, ACTIONS.VIEW_CASE).url).toBe(
      'https://kibana.example.com/s/soc/app/security/cases/case-1'
    );
  });

  test('the owner picks the solution app when the link has to be derived', () => {
    const { blocks } = incidentMessage(
      withCase({ caseLink: null, caseOwner: 'observability' }),
      []
    );
    expect(buttonWith(blocks, ACTIONS.VIEW_CASE).url).toContain('/app/observability/cases/');
  });

  test('the summary line and the button always agree on the link', () => {
    const { blocks } = incidentMessage(withCase({ caseLink: null }), []);
    const url = buttonWith(blocks, ACTIONS.VIEW_CASE).url;
    expect(JSON.stringify(blocks)).toContain(`<${url}|`);
  });

  test('no button is ever emitted without a url', () => {
    for (const link of [null, undefined, '', 'not a url', '/relative']) {
      const { blocks } = incidentMessage(withCase({ caseLink: link }), []);
      const button = buttonWith(blocks, ACTIONS.VIEW_CASE);
      if (button) expect(button.url).toMatch(/^https?:\/\//);
    }
  });

  test('a link button carries no value - the url is the whole payload', () => {
    const { blocks } = incidentMessage(withCase(), []);
    expect(buttonWith(blocks, ACTIONS.VIEW_CASE)).not.toHaveProperty('value');
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
    expect(
      incidentMessage(rec({ alertIds: ['a1', 'a2'] }), ['a1', 'a2']).text
    ).toBe('2 related alerts on web-01: Malware Detected');
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