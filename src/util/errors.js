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
};