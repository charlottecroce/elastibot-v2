'use strict';

const { createLogger, redact, serializeError } = require('../src/util/logger');
const {
  UserFacingError,
  AppError,
  isUserFacing,
  describeAxiosError,
  toUserMessage,
} = require('../src/util/errors');
const { handleHandlerError } = require('../src/util/errorHandler');

/*
 * The logger is the one component that sees every API key, token and error body
 * in the system. These tests are mostly about what must NOT come out of it
 */

const API_KEY = 'VnVhQ2ZHY0JDZGJrU29tZUFwaUtleQ==';

/** A logger that captures records instead of writing them */
function capturing(level = 'trace') {
  const records = [];
  const log = createLogger({ sink: (r) => records.push(r), level });
  return { log, records };
}

/** axios-shaped rejection, including the header that must never be logged */
function axiosError(status, body) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, statusText: 'Error', data: body },
    config: {
      method: 'post',
      baseURL: 'https://es.internal:9200',
      url: '/.alerts-security.alerts-*/_search',
      headers: { Authorization: `ApiKey ${API_KEY}`, 'kbn-xsrf': 'elastibot' },
    },
  });
}

describe('logger levels', () => {
  test('records below the configured level are dropped', () => {
    const { log, records } = capturing('warn');
    log.debug('nope');
    log.info('nope');
    log.warn('yes');
    log.error('yes');
    expect(records.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  test('child loggers inherit and extend bindings', () => {
    const { log, records } = capturing();
    const child = log.child({ scope: 'watcher:alerts' }).child({ spaceId: 'soc' });
    child.info('polled', { count: 3 });
    expect(records[0]).toMatchObject({ scope: 'watcher:alerts', spaceId: 'soc', count: 3 });
  });

  test('every record carries a timestamp, level and message', () => {
    const { log, records } = capturing();
    log.info('hello');
    expect(Date.parse(records[0].time)).not.toBeNaN();
    expect(records[0]).toMatchObject({ level: 'info', msg: 'hello' });
  });
});

describe('redaction', () => {
  test('secret-named fields never reach the sink', () => {
    const { log, records } = capturing();
    log.info('registered', { apiKey: API_KEY, kibanaUsername: 'jsmith' });
    expect(records[0].apiKey).toBe('[redacted]');
    expect(records[0].kibanaUsername).toBe('jsmith'); // non-secrets survive
  });

  test('nested secrets are caught too', () => {
    const { log, records } = capturing();
    log.info('config', { elastic: { esUrl: 'https://es:9200', serviceApiKey: API_KEY } });
    expect(records[0].elastic.serviceApiKey).toBe('[redacted]');
    expect(records[0].elastic.esUrl).toBe('https://es:9200');
  });

  test('secret-shaped values are scrubbed even in an innocent string', () => {
    const { log, records } = capturing();
    log.error('auth failed for xoxb-99999999-aaaaaaaaaaaa on connect');
    expect(records[0].msg).not.toContain('xoxb-99999999');
    expect(records[0].msg).toContain('auth failed');
  });

  test('our own at-rest ciphertext is scrubbed', () => {
    expect(JSON.stringify(redact({ note: `enc:${'A'.repeat(40)}` }))).not.toContain('AAAAAAAA');
  });

  test('circular structures log instead of throwing', () => {
    const { log, records } = capturing();
    const node = { name: 'a' };
    node.self = node;
    expect(() => log.info('cycle', { node })).not.toThrow();
    expect(records[0].node.self).toBe('[circular]');
  });

  test('deep structures are capped rather than walked forever', () => {
    let deep = { end: true };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    expect(() => redact(deep)).not.toThrow();
    expect(JSON.stringify(redact(deep))).toContain('depth-limit');
  });
});

describe('error serialization', () => {
  test('the Authorization header never appears in a log record', () => {
    const { log, records } = capturing();
    log.error('lookup failed', { err: axiosError(401, { message: 'unauthorized' }) });
    const dumped = JSON.stringify(records[0]);
    expect(dumped).not.toContain(API_KEY);
    expect(dumped).not.toContain('Authorization');
  });

  test('but the parts an operator needs are kept', () => {
    const { log, records } = capturing();
    log.error('lookup failed', { err: axiosError(404, { message: 'index_not_found' }) });
    expect(records[0].err.status).toBe(404);
    expect(records[0].err.body.message).toBe('index_not_found');
    expect(records[0].err.request.url).toContain('_search');
    expect(records[0].err.request.method).toBe('post');
  });

  test('plain errors keep name, message and a trimmed stack', () => {
    const out = serializeError(new TypeError('bad thing'));
    expect(out.name).toBe('TypeError');
    expect(out.message).toBe('bad thing');
    expect(out.stack.split('\n').length).toBeLessThanOrEqual(12);
  });

  test('causes are serialized recursively', () => {
    const out = serializeError(new AppError('outer', { cause: new Error('inner') }));
    expect(out.cause.message).toBe('inner');
  });
});

describe('error taxonomy', () => {
  test('only user-facing errors are marked safe to show', () => {
    expect(isUserFacing(new UserFacingError('bad window'))).toBe(true);
    expect(isUserFacing(new Error('ECONNREFUSED 10.0.0.5:9200'))).toBe(false);
    expect(isUserFacing(null)).toBe(false);
  });

  test('401 and 403 tell the analyst to re-run /start', () => {
    expect(describeAxiosError(axiosError(401, {}), 'Looking up alert').message).toMatch(/\/start/);
    expect(describeAxiosError(axiosError(403, {}), 'Looking up alert').message).toMatch(/\/start/);
  });

  test('404 is reported as not found, with context', () => {
    const err = describeAxiosError(axiosError(404, { message: 'missing' }), 'Looking up case');
    expect(err.message).toMatch(/Looking up case/);
    expect(err.message).toMatch(/404/);
  });

  test('timeouts and refused connections get their own advice', () => {
    const timeout = Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' });
    expect(describeAxiosError(timeout, 'Looking up alert').message).toMatch(/didn't answer in time/);

    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(describeAxiosError(refused, 'Looking up alert').message).toMatch(/KIBANA_URL/);
  });

  test('everything from describeAxiosError is safe to show', () => {
    expect(isUserFacing(describeAxiosError(axiosError(500, {}), 'x'))).toBe(true);
  });

  test('an unexpected error becomes an opaque reference, not a raw message', () => {
    const msg = toUserMessage(new Error('connect ECONNREFUSED 10.0.0.5:9200'), 'a1b2c3d4');
    expect(msg).not.toContain('10.0.0.5');
    expect(msg).toContain('a1b2c3d4');
  });
});

describe('handleHandlerError', () => {
  function fakeReply() {
    const sent = [];
    return { sent, ephemeral: async (m) => sent.push(m) };
  }

  test('a user-facing error is echoed verbatim and logged as info, not error', async () => {
    const { log, records } = capturing();
    const reply = fakeReply();
    await handleHandlerError(new UserFacingError('No alert found.'), { log, reply, traceId: 'aaaa1111' });

    expect(reply.sent[0]).toBe(':x: No alert found.');
    expect(records[0].level).toBe('info'); // expected outcome, not a defect
  });

  test('an unexpected error is logged at error level and hidden from the user', async () => {
    const { log, records } = capturing();
    const reply = fakeReply();
    await handleHandlerError(new Error('ECONNREFUSED 10.0.0.5:9200'), { log, reply, traceId: 'bbbb2222' });

    expect(reply.sent[0]).not.toContain('10.0.0.5');
    expect(reply.sent[0]).toContain('bbbb2222'); // the same id is in the log
    expect(records[0].level).toBe('error');
    expect(records[0].err.message).toContain('ECONNREFUSED'); // full detail kept in the log
  });

  test('the usage suffix is appended for user-facing errors only', async () => {
    const { log } = capturing();

    const a = fakeReply();
    await handleHandlerError(new UserFacingError('bad window'), {
      log, reply: a, traceId: 'x', userErrorSuffix: '*Usage:* `/stats`',
    });
    expect(a.sent[0]).toContain('*Usage:*');

    const b = fakeReply();
    await handleHandlerError(new Error('boom'), {
      log, reply: b, traceId: 'x', userErrorSuffix: '*Usage:* `/stats`',
    });
    expect(b.sent[0]).not.toContain('*Usage:*');
  });

  test('a failure while replying is logged, not thrown', async () => {
    const { log, records } = capturing();
    const reply = { ephemeral: async () => { throw new Error('slack is down'); } };

    await expect(
      handleHandlerError(new Error('original'), { log, reply, traceId: 'cccc3333' })
    ).resolves.toBeUndefined();

    expect(records.some((r) => r.msg.includes('failed to deliver'))).toBe(true);
  });
});