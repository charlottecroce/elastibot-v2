'use strict';

/*
 * The error taxonomy.
 *
 *   UserFacingError  - the analyst did something we can explain. Show it verbatim
 *   anything else    - our bug or a broken dependency. Log it, show a trace ref
 */

/** Base class so `instanceof AppError` catches everything we raise deliberately */
class AppError extends Error {
  constructor(message, { code, cause, status, expose = false } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.expose = expose;
    if (cause) this.cause = cause;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/** A friendly error whose message is safe to output into Slack */
class UserFacingError extends AppError {
  constructor(message, opts = {}) {
    super(message, { ...opts, expose: true });
  }
}

/** Missing/invalid configuration found at boot. Fatal by definition */
class ConfigError extends AppError {}

/** True when the message is safe to echo straight back to the analyst */
function isUserFacing(err) {
  return Boolean(err && (err instanceof UserFacingError || err.expose === true));
}

/*
 * TLS/certificate failures. Internal Elastic/Kibana deployments very often run
 * on a self-signed or internally-issued cert, and ELASTIC_TLS_REJECT_UNAUTHORIZED
 * defaults to true (TLS verification should be opt-out, not opt-in).
 * The first time someone points this bot at such a cluster, EVERY request fails
 * this way, on both the ES and Kibana clients, on every watcher tick - so it's
 * worth its own actionable message rather than falling into the generic bucket.
 *
 * Node/OpenSSL usually attach a stable `code`, but not always - some paths only
 * set `err.message`, so we also match on that as a fallback
 */
const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function isTlsError(err) {
  if (err?.code && TLS_ERROR_CODES.has(err.code)) return true;
  // Fallback for cases where OpenSSL's reason never made it into a `code`
  return /certificate/i.test(String(err?.message || ''));
}

/**
 * Turn an axios rejection into a user-friendly message
 *
 * @param {Error} err      the rejection
 * @param {string} context what we were doing, e.g. 'Looking up alert'
 * @returns {UserFacingError}
 */
function describeAxiosError(err, context) {
  const status = err?.response?.status;
  const body = err?.response?.data;
  const reason = (body && (body.message || body.error?.reason || body.error)) || err?.message;

  if (status === 401 || status === 403) {
    return new UserFacingError(
      `${context}: Elastic rejected your API key (${status}). ` +
        'Re-run `/start` to register a valid key with the right permissions.',
      { status, cause: err }
    );
  }
  if (status === 404) {
    return new UserFacingError(`${context}: not found (404). ${reason || ''}`.trim(), {
      status,
      cause: err,
    });
  }
  if (status === 429) {
    return new UserFacingError(
      `${context}: Elastic is rate limiting us (429). Try again shortly.`,
      { status, cause: err }
    );
  }
  if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') {
    return new UserFacingError(
      `${context}: Elastic didn't answer in time. It may be under load - try again.`,
      { code: err.code, cause: err }
    );
  }
  if (err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND') {
    return new UserFacingError(
      `${context}: couldn't reach Elastic. Check KIBANA_URL / ELASTICSEARCH_URL.`,
      { code: err.code, cause: err }
    );
  }
  if (isTlsError(err)) {
    return new UserFacingError(
      `${context}: TLS certificate problem talking to Elastic` +
        `${err?.code ? ` (${err.code})` : ''}. If this is an internal cluster with a ` +
        'self-signed or internally-issued certificate, set `ELASTIC_TLS_REJECT_UNAUTHORIZED=false` ' +
        'in `.env`, or install the CA certificate so it verifies normally.',
      { code: err?.code, cause: err }
    );
  }

  return new UserFacingError(`${context}: ${reason || 'request failed'}`.trim(), {
    status,
    cause: err,
  });
}

/**
 * The single place that decides what an analyst is allowed to read.
 * Unexpected errors become a trace reference instead of a raw message
 */
function toUserMessage(err, traceId) {
  if (isUserFacing(err)) return err.message;
  const ref = traceId ? ` (ref \`${traceId}\`)` : '';
  return `Something went wrong on my end${ref}. An admin can find the details in the logs.`;
}

module.exports = {
  AppError,
  UserFacingError,
  ConfigError,
  isUserFacing,
  describeAxiosError,
  toUserMessage,
  isTlsError,
};