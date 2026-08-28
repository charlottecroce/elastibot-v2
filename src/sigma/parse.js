'use strict';

const fs = require('fs');
const { sha256 } = require('./ruleDiff');

/*
 * Reading the two formats this feature deals with.
 *
 * There is deliberately no yaml parser here. The only things we need out of a
 * Sigma file are its id, title, level and status - all top-level scalars on
 * their own line - plus a hash of the bytes. Pulling in a yaml dependency to
 * read four keys would be a poor trade, and the conversion output already
 * carries everything else in JSON
 */

// Top-level keys only: a leading space would make it a nested key belonging to
// something else (logsource, detection, a correlation block)
const ID_RE = /^id:\s*["']?([0-9a-fA-F-]{36})["']?\s*$/m;
const TITLE_RE = /^title:\s*(.+?)\s*$/m;
const LEVEL_RE = /^level:\s*([a-zA-Z]+)\s*$/m;
const STATUS_RE = /^status:\s*([a-zA-Z]+)\s*$/m;

/** Strip one layer of matching quotes from a scalar */
function unquote(value) {
  const s = String(value || '').trim();
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
}

/**
 * Pull the metadata we index on out of raw Sigma yaml.
 *
 * Multi-document files (correlation rules) match the first `id:` in the file,
 * which is the one sigma-cli reports as the converted rule's rule_id
 *
 * @returns {{id: string|null, title: string, level: string|null, status: string|null}}
 */
function metaFromYaml(text) {
  return {
    id: ID_RE.exec(text)?.[1]?.toLowerCase() || null,
    title: unquote(TITLE_RE.exec(text)?.[1] || ''),
    level: LEVEL_RE.exec(text)?.[1]?.toLowerCase() || null,
    status: STATUS_RE.exec(text)?.[1]?.toLowerCase() || null,
  };
}

/**
 * Index a list of rule files by Sigma id.
 *
 * @returns {{byId: Map<string, object>, unidentified: string[]}}
 */
function indexSourceFiles(files) {
  const byId = new Map();
  const unidentified = [];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const meta = metaFromYaml(text);
    if (!meta.id) {
      unidentified.push(file);
      continue;
    }
    byId.set(meta.id, { ...meta, sourcePath: file, sourceHash: sha256(text) });
  }

  return { byId, unidentified };
}

/**
 * ndjson text -> objects. Blank lines and anything that isn't JSON are dropped:
 * sigma-cli writes the occasional bare warning to stdout and one of those
 * shouldn't fail an otherwise good batch
 */
function parseNdjson(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* not a rule - ignore */
    }
  }
  return out;
}

module.exports = { metaFromYaml, indexSourceFiles, parseNdjson, unquote };