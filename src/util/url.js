'use strict';

/*
 * URL predicates
 */

/**
 * True only for an absolute http(s) URL.
 *
 * Deliberately strict: a protocol-relative `//host/path` or a bare `host:9200`
 * either throws in the URL constructor or parses with the wrong protocol, and
 * both produce a link an analyst cannot click and a base URL axios cannot use.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isAbsoluteHttpUrl(value) {
  if (typeof value !== 'string' || value === '') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = { isAbsoluteHttpUrl };