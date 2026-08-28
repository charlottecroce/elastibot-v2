'use strict';

const {
  SIGMA_USAGE,
  STATE,
  parseSigmaCommand,
  listSpaces,
  compareSpace,
  searchSigmaRules,
  resolvePageState,
  updateStackRule,
  createStackRule,
  resolveSpaceName,
  getSyncStatus,
} = require('../services/sigmaService');
const {
  spacePickerBlocks,
  updatePageBlocks,
  searchPageBlocks,
  statusBlocks,
  fallbackText,
} = require('../services/sigmaBlocks');
const { createSession, getSession, unpackValue, pageOf } = require('../services/sigmaSession');
const { isUserFacing } = require('../util/errors');
const { ACTIONS, COMMANDS } = require('../constants');

/*
 * /sigma - reconcile the detection rules in a Kibana space against the local
 * Sigma database that `npm run update-sigmaDB` builds.
 *
 *   /sigma update [space:<id>]          what has drifted, with an Update button
 *   /sigma search <keyword> [space:<id>] Sigma rules by keyword, with Add/Update/View
 *   /sigma status                        when the database was last synced
 *
 * Nothing runs until a space is chosen. If the command didn't name one, the
 * first reply is a picker and the parsed command waits in a session until a
 * button answers the question - writing detection rules into whichever space
 * happened to be the default is not a mistake worth making twice.
 *
 * Results are paged, ten to a message. A Slack message caps at 50 blocks and
 * gets unreadable long before that, and a space can easily have hundreds of
 * drifted rules
 */

/** Replace the message the analyst is looking at, rather than posting another */
function replace(respond, payload) {
  return respond({ replace_original: true, ...payload });
}

/** Render one page of a session, resolving anything it needs first */
async function showPage({ respond, session, page, apiKey }) {
  if (session.kind === 'search') {
    // Stack state is resolved a page at a time - see sigmaService
    await resolvePageState(apiKey, session.spaceId, pageOf(session, page).items);
  }

  const blocks =
    session.kind === 'search'
      ? searchPageBlocks(session, page)
      : updatePageBlocks(session, page);

  await replace(respond, { blocks, text: fallbackText(session) });
}

/** Do the work for a subcommand once the space is known, then show page 1 */
async function runInSpace({ sub, query, spaceId, user, slackUserId, respond, log }) {
  const spaceName = await resolveSpaceName(user.apiKey, spaceId);

  const result =
    sub === 'update'
      ? await compareSpace(user.apiKey, spaceId)
      : await searchSigmaRules(query);

  const session = createSession({ ...result, spaceId, spaceName, slackUserId });

  log.info('sigma results ready', {
    sub,
    spaceId,
    results: session.items.length,
  });

  await showPage({ respond, session, page: 1, apiKey: user.apiKey });
}

/**
 * Apply one button to one rule.
 *
 * The `apply` callback RETURNS the fields to set rather than writing them onto
 * the item itself, and they are applied in a single Object.assign once the
 * await has resolved. Two clicks on the same session can overlap, and an item
 * that is half updated renders a button contradicting its own status line.
 *
 * A failure marks the item and re-renders rather than replacing the whole page
 * with an error: nine other rules on that page are still actionable, and losing
 * the list because one rule was deleted in Kibana five minutes ago is a bad
 * trade. Unexpected errors still propagate to the registrar
 */
async function applyToItem({ apply, value, slackUserId, user, respond, log }) {
  const { t, p, i } = unpackValue(value);
  const session = getSession(t, slackUserId);
  const item = session.items[i];
  if (!item) return;

  let fields;
  try {
    fields = await apply(item, session);
  } catch (err) {
    if (!isUserFacing(err)) throw err;
    fields = { state: STATE.FAILED, error: err.message };
    log.info('sigma action rejected', { ruleId: item.ruleId, reason: err.message });
  }

  Object.assign(item, fields);

  await showPage({ respond, session, page: p, apiKey: user.apiKey });
}

module.exports = function registerSigma(reg) {
  reg.command(
    COMMANDS.SIGMA,
    async ({ text, user, reply, respond, slackUserId, log }) => {
      const { sub, query, spaceId } = parseSigmaCommand(text);

      if (sub === 'help') {
        await reply.ephemeral(SIGMA_USAGE);
        return;
      }

      if (sub === 'status') {
        const status = await getSyncStatus();
        await reply.ephemeral({ blocks: statusBlocks(status), text: 'Sigma database status' });
        return;
      }

      // Fail on an empty search before asking which space it should run in
      if (sub === 'search' && !query) {
        await reply.ephemeral(SIGMA_USAGE);
        return;
      }

      if (!spaceId) {
        const spaces = await listSpaces(user.apiKey);
        const pending = createSession({ kind: 'pending', sub, query, slackUserId, items: [] });
        await reply.ephemeral({
          blocks: spacePickerBlocks(spaces, pending.token, {
            verb: sub === 'update' ? 'check' : 'search in',
          }),
          text: 'Pick a space',
        });
        return;
      }

      await reply.ephemeral(
        sub === 'update'
          ? `Comparing \`${spaceId}\` against the Sigma database…`
          : `Searching the Sigma database for \`${query}\`…`
      );
      await runInSpace({ sub, query, spaceId, user, slackUserId, respond, log });
    },
    {
      requireUser: true,
      usage: SIGMA_USAGE,
      userErrorSuffix: SIGMA_USAGE,
      minArgs: 1,
    }
  );

  /* Space picker - resumes the command that was parked waiting for an answer */
  reg.action(
    ACTIONS.SIGMA_SPACE_SELECT,
    async ({ action, user, slackUserId, respond, log }) => {
      const { t, s } = unpackValue(action.value);
      const pending = getSession(t, slackUserId);

      await replace(respond, {
        text:
          pending.sub === 'update'
            ? `Comparing \`${s}\` against the Sigma database…`
            : `Searching the Sigma database…`,
        blocks: [],
      });

      await runInSpace({
        sub: pending.sub,
        query: pending.query,
        spaceId: s,
        user,
        slackUserId,
        respond,
        log,
      });
    },
    { requireUser: true }
  );

  /* Back / Next */
  reg.action(
    ACTIONS.SIGMA_PAGE,
    async ({ action, user, slackUserId, respond }) => {
      const { t, p } = unpackValue(action.value);
      const session = getSession(t, slackUserId);
      await showPage({ respond, session, page: p, apiKey: user.apiKey });
    },
    { requireUser: true }
  );

  /* Update rule - patches the stack rule with the Sigma version */
  reg.action(
    ACTIONS.SIGMA_RULE_UPDATE,
    async ({ action, user, slackUserId, respond, log }) => {
      await applyToItem({
        value: action.value,
        slackUserId,
        user,
        respond,
        log,
        apply: async (item, session) => {
          const result = await updateStackRule(user.apiKey, session.spaceId, item.ruleId);
          return {
            state: result.alreadyCurrent ? STATE.CURRENT : STATE.UPDATED,
            changes: [],
          };
        },
      });
    },
    { requireUser: true }
  );

  /* Add rule - creates a rule the space doesn't have yet */
  reg.action(
    ACTIONS.SIGMA_RULE_ADD,
    async ({ action, user, slackUserId, respond, log }) => {
      await applyToItem({
        value: action.value,
        slackUserId,
        user,
        respond,
        log,
        apply: async (item, session) => {
          const result = await createStackRule(user.apiKey, session.spaceId, item.ruleId);
          return { state: STATE.ADDED, stackId: result.stackId, enabled: result.enabled };
        },
      });
    },
    { requireUser: true }
  );

  /*
   * View rule is a link button. Slack still dispatches an interaction for it,
   * and an unhandled one logs a Bolt warning on every click, so it gets a
   * handler that does nothing but let the registrar ack
   */
  reg.action(ACTIONS.SIGMA_RULE_VIEW, async () => {});
};