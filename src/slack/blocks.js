'use strict';

/*
 * Block Kit primitives.
 *
 * Every module that renders a list needs the same handful of builders, and
 * three copies of `section()` is three places for a Slack schema change to
 * hide. sigmaBlocks.js and services/format.js should both be built out of
 * these.
 *
 * Escaping is deliberately NOT done here. util/mrkdwn owns that, and a builder
 * that escaped its own input would double-escape anything already passed
 * through it - callers escape, builders assemble
 */

const MAX_BLOCKS = 50; // Slack's per-message ceiling
const MAX_ACTION_ELEMENTS = 25; // Slack's per-actions-block ceiling

/**
 * Slack rejects a section or context whose text is empty, and the whole message
 * fails with it - so these return null and `compact` drops them, rather than
 * every caller having to remember the check
 */
function section(text, accessory) {
  if (!text) return null;
  const block = { type: 'section', text: { type: 'mrkdwn', text } };
  if (accessory) block.accessory = accessory;
  return block;
}

function context(text) {
  if (!text) return null;
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

const divider = () => ({ type: 'divider' });

function button(text, actionId, value, { style, url } = {}) {
  const btn = {
    type: 'button',
    text: { type: 'plain_text', text, emoji: true },
    action_id: actionId,
  };
  if (value) btn.value = value;
  if (style) btn.style = style;
  if (url) btn.url = url;
  return btn;
}

/** An actions block, or null when there is nothing to put in it */
function actions(elements) {
  const shown = (elements || []).filter(Boolean).slice(0, MAX_ACTION_ELEMENTS);
  return shown.length ? { type: 'actions', elements: shown } : null;
}

/** Chunk a list into rows of `size` */
function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

/**
 * Flatten, drop the nulls the builders return for empty content, and stay under
 * the message limit - Slack rejects a 51-block message outright rather than
 * truncating it
 */
function compact(blocks) {
  return blocks.flat(Infinity).filter(Boolean).slice(0, MAX_BLOCKS);
}

module.exports = {
  section,
  context,
  divider,
  button,
  actions,
  chunk,
  compact,
  MAX_BLOCKS,
  MAX_ACTION_ELEMENTS,
};