'use strict';

/*
 * Centralized logging.
 *
 * Everything in Elastibot logs through here instead of console.*, so that:
 *   - output has consistent structure (level, time, scope, message, fields)
 *   - API keys and Slack tokens are redacted before they can reach a log sink
 *   - noise can be turned down per environment with one env var
 *
 * Usage:
 *   const { logger } = require('./util/logger');
 *   const log = logger.child({ scope: 'watcher:alerts' });
 *   log.info('posted incident', { channel, count: 3 });
 *   log.error('post failed', { err });      // `err` is serialized specially
 *
 * Levels: trace < debug < info < warn < error < fatal < silent
 * Config: config.logging.{level,format,redact}  (LOG_LEVEL / LOG_FORMAT / LOG_REDACT)
 */

const LEVELS = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
});

const LEVEL_NAMES = Object.keys(LEVELS).filter((l) => l !== 'silent');

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const REDACTED = '[redacted]';

// Any field whose NAME looks secret is replaced wholesale
const SECRET_KEY_RE =
  /(api[-_]?key|token|secret|password|passwd|authorization|credential|encryptionkey|signing)/i;

/*
 * Secret-looking VALUES that show up inside otherwise innocent strings (a URL,
 * an error message, a stack trace). Slack tokens are structured enough to spot
 */
const SECRET_VALUE_RES = [
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack bot/user/app tokens
  /xapp-[A-Za-z0-9-]{10,}/g, // Slack app-level tokens
  /ApiKey\s+[A-Za-z0-9+/=_-]{16,}/gi, // Elastic Authorization header value
  /enc:[A-Za-z0-9+/=]{24,}/g, // our own at-rest ciphertext
];

function scrubString(value) {
  let out = value;
  for (const re of SECRET_VALUE_RES) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Deep-copy a value, replacing secrets. Handles cycles, caps depth and array
 * length so one enormous object can't stall the process
 */
function redact(value, { depth = 0, seen = new WeakSet() } = {}) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return String(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeError(value);

  if (depth >= 6) return '[depth-limit]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const capped = value.slice(0, 50).map((v) => redact(v, { depth: depth + 1, seen }));
    if (value.length > 50) capped.push(`[+${value.length - 50} more]`);
    return capped;
  }

  if (value instanceof Map) {
    return redact(Object.fromEntries(value), { depth: depth + 1, seen });
  }
  if (value instanceof Set) {
    return redact([...value], { depth: depth + 1, seen });
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redact(v, { depth: depth + 1, seen });
  }
  return out;
}

/**
 * Errors don't survive JSON.stringify, and axios errors carry the whole request
 * config (including the Authorization header) on `err.config`. We pull out only
 * the fields worth logging and never touch headers
 */
function serializeError(err) {
  if (!err || typeof err !== 'object') return err;

  const out = {
    name: err.name,
    message: scrubString(String(err.message || '')),
  };
  if (err.code) out.code = err.code;
  if (err.status) out.status = err.status;

  // axios shape
  const res = err.response;
  if (res) {
    out.status = res.status;
    out.statusText = res.statusText;
    const body = res.data;
    if (body !== undefined) {
      out.body = redact(typeof body === 'string' ? body.slice(0, 500) : body, { depth: 4 });
    }
  }
  if (err.config) {
    out.request = {
      method: err.config.method,
      // baseURL + url only - never params/headers/data, which carry credentials
      url: scrubString(String(err.config.baseURL || '') + String(err.config.url || '')),
    };
  }
  if (err.stack) out.stack = scrubString(err.stack).split('\n').slice(0, 12).join('\n');
  if (err.cause instanceof Error) out.cause = serializeError(err.cause);

  return out;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const COLORS = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[35m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

function formatJson(rec) {
  return JSON.stringify(rec);
}

function indent(text) {
  return String(text)
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

function formatPretty(rec, { color }) {
  const c = (code, s) => (color ? `${code}${s}${COLORS.reset}` : s);
  const time = rec.time.slice(11, 23); // HH:MM:SS.mmm
  const level = c(COLORS[rec.level] || '', rec.level.toUpperCase().padEnd(5));
  const scope = rec.scope ? c(COLORS.dim, `[${rec.scope}] `) : '';

  const { time: _t, level: _l, scope: _s, msg, err, ...rest } = rec;
  const pairs = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');

  let line = `${c(COLORS.dim, time)} ${level} ${scope}${msg}`;
  if (pairs) line += ` ${c(COLORS.dim, pairs)}`;
  if (err) {
    const detail = err.stack || `${err.name}: ${err.message}`;
    line += `\n${c(COLORS.dim, indent(detail))}`;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Resolve settings without hard-depending on config, so the logger stays usable
 * if config itself blows up (and so tests that stub config don't break it)
 */
function resolveSettings() {
  let cfg = {};
  try {
    cfg = require('../../config').logging || {};
  } catch {
    /* config unavailable or still loading - fall back to env */
  }

  let level = process.env.LOG_LEVEL || cfg.level || 'info';
  if (!(level in LEVELS)) level = 'info';

  const format = process.env.LOG_FORMAT || cfg.format || 'pretty';
  const redactEnabled = cfg.redact === undefined ? true : Boolean(cfg.redact);

  return { level, format, redact: redactEnabled };
}

// One process-wide settings object, resolved on first use. Loggers created with
// `settings = null` follow it, so setLevel() on the root reaches every child
let sharedSettings = null;
function getSharedSettings() {
  if (!sharedSettings) sharedSettings = resolveSettings();
  return sharedSettings;
}

class Logger {
  /**
   * @param {object} bindings fields stamped on every record
   * @param {object|null} settings null = follow the process-wide settings
   * @param {function|null} sink receives records instead of stdout/stderr
   */
  constructor(bindings = {}, settings = null, sink = null) {
    this.bindings = bindings;
    this._settings = settings;
    this._sink = sink;
  }

  get settings() {
    return this._settings || getSharedSettings();
  }

  /** Derive a logger that stamps extra fields on every record (e.g. a scope) */
  child(bindings = {}) {
    return new Logger({ ...this.bindings, ...bindings }, this._settings, this._sink);
  }

  /** Override the level at runtime. Used by tests; there is no runtime command for it */
  setLevel(level) {
    if (!(level in LEVELS)) throw new Error(`Unknown log level: ${level}`);
    this.settings.level = level;
    return this;
  }

  isLevelEnabled(level) {
    return LEVELS[level] >= LEVELS[this.settings.level];
  }

  write(level, msg, fields) {
    if (!this.isLevelEnabled(level)) return;

    const settings = this.settings;
    const merged = { ...this.bindings, ...(fields || {}) };
    const payload = settings.redact ? redact(merged) : merged;

    // The message itself gets scrubbed too - a token pasted into an error
    // string is just as leaked as one sitting in a field
    const text = String(msg);
    const rec = {
      time: new Date().toISOString(),
      level,
      msg: settings.redact ? scrubString(text) : text,
      ...payload,
    };

    if (this._sink) {
      this._sink(rec);
      return;
    }

    const line =
      settings.format === 'json'
        ? formatJson(rec)
        : formatPretty(rec, { color: process.stdout.isTTY && !process.env.NO_COLOR });

    // warn and worse go to stderr so they survive a stdout-only pipe
    if (LEVELS[level] >= LEVELS.warn) process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}

// Attach one method per level: log.info(msg, fields)
for (const level of LEVEL_NAMES) {
  Logger.prototype[level] = function levelMethod(msg, fields) {
    this.write(level, msg, fields);
  };
}

/**
 * Build an independent logger with its own settings - handy for tests
 * (pass a sink to capture records). Detached from the shared settings object
 */
function createLogger({ bindings = {}, sink = null, ...overrides } = {}) {
  const settings = { ...resolveSettings(), ...overrides };
  return new Logger(bindings, settings, sink);
}

/** The process-wide root logger. Prefer `logger.child({ scope })` at module top */
const logger = new Logger({});

module.exports = { logger, createLogger, Logger, LEVELS, redact, serializeError };