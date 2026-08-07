'use strict';

const config = require('../../config');
const { esc, mrkdwnLink, ruleBreakdown } = require('../util/mrkdwn');

/*
 * Slack message builders.
 *
 * functions that return Block Kit.
 * The /stats table helpers stay because statsBlocks is their only consumer
 */

/*
 * Helpers for the /stats tables. Those live inside ``` fences, where Slack does
 * NOT interpret mrkdwn - so they take plain(), not esc(). A stray backtick would
 * close the fence early, so it gets swapped out
 */

/** Single-line, fence-safe, length-capped text for use inside a code block */
function plain(s, max = 34) {
  const one = String(s ?? '')
    .replace(/[`\r\n]+/g, ' ')
    .trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** 1204 > "1,204" */
function num(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Largest value in a list, without spreading it onto the call stack */
function maxOf(values) {
  let max = 0;
  for (const v of values) if (v > max) max = v;
  return max;
}

/** Fixed-width bar, e.g. "█████     " */
function bar(value, max, width = 10) {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return '█'.repeat(Math.max(value > 0 ? 1 : 0, filled)).padEnd(width, ' ');
}

/** One-line histogram of a series, e.g. "▁▂▄█▅▂▁" */
function sparkline(values) {
  const ticks = '▁▂▃▄▅▆▇█';
  const max = maxOf(values);
  if (!max) return ' '.repeat(values.length); // same glyph a zero gets below
  return values
    .map((v) =>
      v === 0 ? ' ' : ticks[Math.min(ticks.length - 1, Math.ceil((v / max) * (ticks.length - 1)))]
    )
    .join('');
}

/**
 * Aligned "label  count  bar  note" table inside a code fence
 * @param {Array} items  [{ label, count, note }]
 */
function countTable(items, { barWidth = 10, labelWidth = 34 } = {}) {
  if (!items || !items.length) return '_nothing in this window_';
  const max = maxOf(items.map((i) => i.count));
  const labels = items.map((i) => plain(i.label, labelWidth));
  const nameW = maxOf(labels.map((l) => l.length));
  const countW = maxOf(items.map((i) => num(i.count).length));
  const lines = items.map((i, idx) => {
    const row = `${labels[idx].padEnd(nameW)}  ${num(i.count).padStart(countW)}  ${bar(
      i.count,
      max,
      barWidth
    )}`;
    return i.note ? `${row}  ${plain(i.note, 40)}` : row;
  });
  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

/** section block from mrkdwn text */
function section(text) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** { key, count } > countTable row */
function toRow(b) {
  return { label: b.key, count: b.count };
}

/** Success message after a case is created (single or grouped alerts) */
function caseCreatedBlocks({
  title,
  caseId,
  spaceName,
  ruleName,
  ruleCounts,
  alertCount = 1,
  warning,
  link,
  slackUserId,
}) {
  const meta = [
    { type: 'mrkdwn', text: `*Case ID:* \`${esc(caseId)}\`` },
    { type: 'mrkdwn', text: `*Space:* ${esc(spaceName)}` },
  ];
  if (alertCount > 1) meta.push({ type: 'mrkdwn', text: `*Alerts:* ${alertCount}` });

  const rulesEl =
    alertCount > 1
      ? { type: 'mrkdwn', text: `*Rules:* ${ruleBreakdown(ruleCounts, ruleName)}` }
      : { type: 'mrkdwn', text: `*Rule:* ${esc(ruleName)}` };

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        // mrkdwnLink, not string interpolation: a result object without `link`
        // used to render the literal text "<undefined|SO-073026-Malware>"
        text: `:white_check_mark: *Case created* by <@${slackUserId}>\n*${mrkdwnLink(link, title)}*`,
      },
    },
    { type: 'context', elements: meta },
    { type: 'context', elements: [rulesEl] },
    {
      /*
       * The template with the real case id already in it, inside a fence.
       *
       * plain(), not esc(): Slack does not interpret mrkdwn inside a fence, and
       * a backtick in the id would close it early
       */
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Add more alerts:\n\`\`\`\n/add_alert ${plain(caseId, 128)} <alertID>\n\`\`\``,
      },
    },
  ];
  if (warning) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:warning: ${esc(warning)}` }],
    });
  }
  return blocks;
}

/** Success message after an alert is added to an existing case */
function alertAddedBlocks({ caseId, alertId, ruleName, link, slackUserId }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `:heavy_plus_sign: <@${slackUserId}> added alert \`${esc(alertId)}\` ` +
          `(${esc(ruleName)}) to case ${mrkdwnLink(link, caseId)}`,
      },
    },
  ];
}

/** New-case notification posted by the watcher */
function newCaseBlocks({ title, caseId, spaceName, link, createdBy }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:open_file_folder: *New case* — *${mrkdwnLink(link, title)}*`,
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `*Case ID:* \`${esc(caseId)}\`` },
        { type: 'mrkdwn', text: `*Space:* ${esc(spaceName)}` },
        { type: 'mrkdwn', text: `*Created by:* ${esc(createdBy || 'unknown')}` },
      ],
    },
  ];
}

/*
 * /stats output. Takes the shaped object from statsService.shapeStats
 *
 * Slack caps a message at 50 blocks and any one text field at 3000 chars, so
 * every list here is already capped to config.stats.topN upstream
 */
function statsBlocks(stats) {
  const { query, total, activity } = stats;
  const filters = Object.entries(query.filters || {})
    .map(([k, v]) => `${k}: \`${esc(v)}\``)
    .join('  ·  ');

  const header = [
    section(`*Alert statistics* — last *${esc(query.windowLabel)}*`),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            `${esc(query.from)} → ${esc(query.to)} (${esc(query.timeZone)})` +
            (filters ? `\n${filters}` : ''),
        },
      ],
    },
  ];

  if (!total) {
    return [
      ...header,
      section(':shrug: No alerts matched. Try a wider window, e.g. `/stats 30d`.'),
    ];
  }

  const blocks = [
    ...header,
    { type: 'divider' },
    section(
      `*${num(total)}* alerts  ·  *${num(stats.distinct.rules)}* rules  ·  ` +
        `*${num(stats.distinct.hosts)}* hosts  ·  *${num(stats.distinct.users)}* users\n` +
        `*${num(activity.perDay)}* alerts/day avg  ·  ` +
        `*${stats.inCases.pct}%* attached to a case  ·  ` +
        `avg risk *${num(stats.risk.avg)}* (max ${num(stats.risk.max)})`
    ),
  ];

  if (stats.severities.length || stats.workflow.length) {
    const sev = stats.severities.map((s) => `${esc(s.key)} *${num(s.count)}*`).join('  ·  ');
    const wf = stats.workflow.map((s) => `${esc(s.key)} *${num(s.count)}*`).join('  ·  ');
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `*Severity:* ${sev || 'n/a'}` },
        { type: 'mrkdwn', text: `*Status:* ${wf || 'n/a'}` },
      ],
    });
  }

  blocks.push(
    section(
      `*Top rules by volume*\n${countTable(
        stats.topRules.map((r) => ({
          label: r.name,
          count: r.count,
          note: `${r.hosts} hosts · ${r.caseRate}% cased`,
        }))
      )}`
    )
  );

  if (stats.noisyRules.length) {
    blocks.push(
      section(
        `*Noisiest rules* - alerts per distinct host\n${countTable(
          stats.noisyRules.map((r) => ({
            label: r.name,
            count: r.perHost,
            note: `${num(r.count)} alerts / ${r.hosts} hosts`,
          }))
        )}`
      )
    );
  }

  if (stats.topHosts.length) {
    blocks.push(section(`*Top hosts*\n${countTable(stats.topHosts.map(toRow))}`));
  }
  if (stats.topUsers.length) {
    blocks.push(section(`*Top users*\n${countTable(stats.topUsers.map(toRow))}`));
  }
  if (stats.topProcesses.length) {
    blocks.push(section(`*Top processes*\n${countTable(stats.topProcesses.map(toRow))}`));
  }
  if (stats.topSpaces.length > 1) {
    blocks.push(section(`*Spaces*\n${countTable(stats.topSpaces.map(toRow))}`));
  }

  // Activity: hour-of-day as a sparkline, weekdays as a small table
  blocks.push(
    section(
      `*By hour of day* (${esc(query.timeZone)})\n` +
        '```\n' +
        `00h ${sparkline(activity.byHour)} 23h\n` +
        `peak ${String(activity.busiestHour).padStart(2, '0')}:00 (${num(
          activity.byHour[activity.busiestHour]
        )})   quietest ${String(activity.quietestHour).padStart(2, '0')}:00 (${num(
          activity.byHour[activity.quietestHour]
        )})\n` +
        '```'
    ),
    section(
      `*By day of week*\n${countTable(
        activity.byWeekday.map((c, i) => ({ label: WEEKDAYS[i], count: c })),
        { labelWidth: 9 }
      )}`
    )
  );

  const busiest = activity.peakDay
    ? `Busiest day: *${esc(activity.peakDay.date)}* (${num(activity.peakDay.count)} alerts)`
    : '';
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text:
          `${busiest}  ·  \`/stats 30d host:web-01\` · \`/stats 24h rule:"Rule name"\` · ` +
          'add `share` to post it in channel',
      },
    ],
  });

  return blocks;
}

/** Usage text for `/stats help` and bad input */
const STATS_USAGE =
  '*Usage:* `/stats [window] [filters] [share]`\n' +
  '• window - `24h`, `7d`, `2w` (default `' +
  config.stats.defaultWindow +
  '`, max ' +
  config.stats.maxWindowDays +
  'd)\n' +
  '• filters - `rule:"Rule name"`, `host:web-01`, `user:jsmith`, `space:default`\n' +
  '• `share` posts the result in-channel instead of only to you\n' +
  '_e.g._ `/stats 30d space:soc`';

module.exports = {
  plain,
  num,
  bar,
  sparkline,
  countTable,
  caseCreatedBlocks,
  alertAddedBlocks,
  newCaseBlocks,
  statsBlocks,
  STATS_USAGE,
};