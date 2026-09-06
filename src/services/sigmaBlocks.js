'use strict';

const config = require('../../config');
const { ACTIONS } = require('../constants');
const { STATE } = require('../sigma/state');
const { esc, fenceSafe } = require('../util/mrkdwn');
const { section, context, divider, button, actions, chunk, compact } = require('../slack/blocks');
const { ruleUrl } = require('./kibanaLinks');
const { packValue, pageOf } = require('./sigmaSession');

/*
 * Block Kit for /sigma. Builders only - nothing here talks to Slack, Elastic or
 * the database, which is what makes the layout testable.
 *
 * Slack caps a message at 50 blocks. A page is pageSize items at two blocks
 * each plus a header and a footer, so the default of 10 leaves plenty of room;
 * raising SIGMA_PAGE_SIZE past ~20 would not - hence the range check in
 * config/validate.js
 */

/*
 * 25 buttons over five rows. Not a Slack limit - `actions` caps a single block
 * at 25 elements and these are chunked into rows of five - but a picker longer
 * than this is a list, and `space:<id>` is the better answer for a stack with
 * fifty spaces
 */
const MAX_SPACE_BUTTONS = 25;
const BUTTONS_PER_ROW = 5;

/** A value squeezed into something that fits on one line of a Slack message */
function short(value, max = 70) {
  if (Array.isArray(value)) return fenceSafe(value.join(', '), { max });
  if (value && typeof value === 'object') return fenceSafe(JSON.stringify(value), { max });
  const text = fenceSafe(value, { max });
  return text || '_empty_';
}

/**
 * The space picker, shown whenever the command didn't say `space:<id>`.
 *
 * Every path into /sigma writes to a specific space, so guessing one is not an
 * option - "which space" is asked before anything is read, let alone changed
 */
function spacePickerBlocks(spaces, token, { verb }) {
  const shown = spaces.slice(0, MAX_SPACE_BUTTONS);

  const rows = chunk(
    shown.map((space) =>
      button(
        fenceSafe(space.name || space.id, { max: 75 }),
        ACTIONS.SIGMA_SPACE_SELECT,
        packValue({ t: token, s: space.id })
      )
    ),
    BUTTONS_PER_ROW
  ).map(actions);

  return compact([
    section(`*Which space should I ${esc(verb)}?*`),
    rows,
    spaces.length > shown.length
      ? context(
          `Showing ${shown.length} of ${spaces.length} spaces. ` +
            'Add `space:<id>` to the command to pick one directly.'
        )
      : null,
  ]);
}

/** "name, description +2 more" */
function changeSummary(changes) {
  const fields = (changes || []).map((c) => `\`${esc(c.field)}\``);
  if (!fields.length) return '';
  if (fields.length <= 3) return fields.join(', ');
  return `${fields.slice(0, 3).join(', ')} +${fields.length - 3} more`;
}

/**
 * The detail line under a drifted rule.
 *
 * `query` is deliberately not spelled out: a converted Lucene query is hundreds
 * of characters and would bury everything else. The field name is enough to
 * tell an analyst to go and look
 */
function changeDetail(changes) {
  const lines = (changes || []).slice(0, 4).map((change) => {
    if (change.field === 'tags') return `*tags* + ${esc(short(change.added, 90))}`;
    if (change.field === 'query') return '*query* — detection logic changed';
    return `*${esc(change.field)}* \`${esc(short(change.from, 40))}\` → \`${esc(short(change.to, 60))}\``;
  });
  if ((changes || []).length > lines.length) {
    lines.push(`_+${changes.length - lines.length} more_`);
  }
  return lines.join('\n');
}

/** Footer shared by both paged views */
function pagerFooter(session, page, total) {
  const elements = [];
  if (page > 1) {
    elements.push(
      button('◀ Back', ACTIONS.SIGMA_PAGE, packValue({ t: session.token, p: page - 1 }))
    );
  }
  if (page < total) {
    elements.push(
      button('Next ▶', ACTIONS.SIGMA_PAGE, packValue({ t: session.token, p: page + 1 }))
    );
  }

  return [
    context(`Page *${page}* of *${total}* · ${session.items.length} rule(s)`),
    actions(elements),
  ];
}

/**
 * The button (or the reason there isn't one) for a rule in a given state.
 *
 * FAILED falls back to whatever button the item had before it failed, so a rule
 * that lost a race with somebody editing it in Kibana can be retried from the
 * same page instead of by running the whole command again
 */
function actionFor(session, page, item) {
  const value = packValue({ t: session.token, p: page, i: item.i });
  const url = item.stackId ? ruleUrl(session.spaceId, item.stackId) : null;

  switch (item.state) {
    case STATE.MISSING:
      return button('Add rule', ACTIONS.SIGMA_RULE_ADD, value, { style: 'primary' });
    case STATE.OUTDATED:
      return button('Update rule', ACTIONS.SIGMA_RULE_UPDATE, value, { style: 'primary' });
    case STATE.CURRENT:
    case STATE.UPDATED:
    case STATE.ADDED:
      return url ? button('View rule', ACTIONS.SIGMA_RULE_VIEW, null, { url }) : null;
    case STATE.FAILED:
      return item.previousState && item.previousState !== STATE.FAILED
        ? actionFor(session, page, { ...item, state: item.previousState })
        : null;
    default:
      return null;
  }
}

/** The status line under a rule, for states where a button isn't the answer */
function stateNote(item) {
  switch (item.state) {
    case STATE.UPDATED:
      return ':white_check_mark: Updated from Sigma.';
    case STATE.ADDED:
      return `:white_check_mark: Added to the space${item.enabled ? '' : ' (disabled)'}.`;
    case STATE.FAILED:
      return `:x: ${esc(item.error || 'That did not work.')}`;
    case STATE.BLOCKED:
      return ':lock: Elastic-managed rule — duplicate it in Kibana to take it over.';
    case STATE.CURRENT:
      return ':white_check_mark: Up to date.';
    default:
      return null;
  }
}

/**
 * One rule: a section with its button, plus a status line underneath.
 *
 * The fallback chain matters. Slack rejects the whole message if a context
 * block's text is empty, and an item whose changes were cleared by a successful
 * update would otherwise produce exactly that
 */
function ruleBlocks(session, page, item, { title }) {
  const note = stateNote(item);
  const detail = item.changes?.length ? changeDetail(item.changes) : null;

  return [
    section(title, actionFor(session, page, item)),
    context(note || detail || `\`${esc(item.ruleId)}\``),
  ];
}

/** /sigma update - one page of drifted rules */
function updatePageBlocks(session, requestedPage) {
  const { page, total, items } = pageOf(session, requestedPage);
  const counts = session.counts || {};

  const header = [
    section(
      `*Sigma drift in* \`${esc(session.spaceName || session.spaceId)}\`\n` +
        `${counts.drifted} of ${counts.matched} Sigma-derived rule(s) differ from the database.`
    ),
    context(
      `Examined ${counts.examined} rule(s) · ${counts.withRuleId} with a ` +
        `\`rule_id\` · ${counts.examined - counts.matched} skipped (not Sigma rules)` +
        (session.truncated ? `\n:warning: Stopped at ${config.sigma.maxStackRules} rules.` : '')
    ),
  ];

  if (!session.items.length) {
    return compact([
      header,
      section(':white_check_mark: Every Sigma rule in this space is up to date.'),
    ]);
  }

  const body = items.map((item) =>
    ruleBlocks(session, page, item, {
      title: `*${esc(item.name)}*\n${changeSummary(item.changes) || '_no field-level changes_'}`,
    })
  );

  return compact([header, divider(), body, pagerFooter(session, page, total)]);
}

/** /sigma search - one page of matching Sigma rules */
function searchPageBlocks(session, requestedPage) {
  const { page, total, items } = pageOf(session, requestedPage);

  const header = section(
    `*Sigma rules matching* \`${esc(session.query)}\`\n` +
      `${session.items.length} result(s) in space \`${esc(session.spaceName || session.spaceId)}\``
  );

  if (!session.items.length) {
    return compact([
      header,
      section(
        'Nothing matched. Try a shorter keyword — search looks at the rule title and description.'
      ),
    ]);
  }

  const body = items.map((item) => {
    const level = item.level ? ` · _${esc(item.level)}_` : '';
    return ruleBlocks(session, page, item, {
      title: `*${esc(item.title)}*${level}\n${esc(short(item.description, 220))}`,
    });
  });

  return compact([header, divider(), body, pagerFooter(session, page, total)]);
}

/** /sigma status */
function statusBlocks({ meta, count }) {
  if (!meta) {
    return compact([
      section(
        ':warning: The Sigma database has no sync recorded. Run `npm run update-sigmaDB` on the host.'
      ),
    ]);
  }

  return compact([
    section(`*Sigma database* — ${count} rule(s)`),
    context(
      `Synced ${esc(new Date(meta.syncedAt).toISOString())} · ` +
        `${esc(meta.repoUrl)}@${esc(meta.repoRef)} \`${esc(String(meta.commit || '').slice(0, 8))}\`\n` +
        `Backend \`${esc(meta.backend)}\` · pipeline \`${esc(meta.pipeline)}\` · ` +
        `${meta.skipped} rule(s) skipped at sync time`
    ),
  ]);
}

/** Plain-text fallback, for notifications and clients that don't render blocks */
function fallbackText(session) {
  return session.kind === 'search'
    ? `Sigma search: ${session.query} (${session.items.length} result(s))`
    : `Sigma drift in ${session.spaceName || session.spaceId}: ${session.items.length} rule(s)`;
}

module.exports = {
  spacePickerBlocks,
  updatePageBlocks,
  searchPageBlocks,
  statusBlocks,
  fallbackText,
  changeSummary,
  changeDetail,
  short,
};