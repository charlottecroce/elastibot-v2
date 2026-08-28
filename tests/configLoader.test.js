'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadConfigFile,
  expandDotted,
  checkPermissions,
  ConfigFileError,
} = require('../config/loader');

/*
 * The loader is the piece that decides which of three possible sources a
 * setting comes from, so its precedence rules are worth pinning down explicitly.
 */

let dir;
const write = (yaml) => {
  const file = path.join(dir, `${Math.random().toString(36).slice(2)}.yml`);
  fs.writeFileSync(file, yaml);
  return file;
};

// Trivial coercers - the real ones live in config/index.js
const asIs = (v) => v;
const asInt = (v, label) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${label} must be an integer`);
  return n;
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elastibot-cfg-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('dotted keys', () => {
  test('a dotted key and a nested block are the same thing', () => {
    expect(expandDotted({ 'elastic.timeout_ms': 15000 })).toEqual({
      elastic: { timeout_ms: 15000 },
    });
  });

  test('the two styles merge rather than clobbering each other', () => {
    expect(
      expandDotted({
        elastic: { timeout_ms: 15000 },
        'elastic.retries': 2,
      })
    ).toEqual({ elastic: { timeout_ms: 15000, retries: 2 } });
  });

  test('a key that is both a value and a section is an error, not a coin toss', () => {
    expect(() => expandDotted({ elastic: 'nope', 'elastic.retries': 2 })).toThrow(ConfigFileError);
  });
});

describe('precedence', () => {
  afterEach(() => {
    delete process.env.TEST_TIMEOUT;
  });

  test('the file beats the environment', () => {
    process.env.TEST_TIMEOUT = '9999';
    const { get } = loadConfigFile({ file: write('elastic:\n  timeout_ms: 1000\n') });
    expect(get('elastic.timeout_ms', 'TEST_TIMEOUT', asInt, 15000)).toBe(1000);
  });

  test('the environment is used when the file says nothing', () => {
    process.env.TEST_TIMEOUT = '9999';
    const { get } = loadConfigFile({ file: write('elastic: {}\n') });
    expect(get('elastic.timeout_ms', 'TEST_TIMEOUT', asInt, 15000)).toBe(9999);
  });

  test('the default is used when neither says anything', () => {
    const { get } = loadConfigFile({ file: write('{}\n') });
    expect(get('elastic.timeout_ms', 'TEST_TIMEOUT', asInt, 15000)).toBe(15000);
  });

  test('an explicit null in the file means "use the default", not null', () => {
    const { get } = loadConfigFile({ file: write('elastic:\n  timeout_ms:\n') });
    expect(get('elastic.timeout_ms', 'TEST_TIMEOUT', asInt, 15000)).toBe(15000);
  });

  /*
   * The reason the file wins is that the other way round is silent: you edit
   * elastibot.yml, restart, nothing changes, and the cause is a variable you
   * forgot was exported. Since it has to be silent for ONE of them, it's the
   * losing side that gets announced
   */
  test('a setting present in both is reported, so the losing side is never silent', () => {
    process.env.TEST_TIMEOUT = '9999';
    const cfg = loadConfigFile({ file: write('elastic:\n  timeout_ms: 1000\n') });
    cfg.get('elastic.timeout_ms', 'TEST_TIMEOUT', asInt, 15000);

    expect(cfg.shadowed).toEqual([{ key: 'elastic.timeout_ms', env: 'TEST_TIMEOUT' }]);
  });

  test('reading the same setting twice only reports it once', () => {
    process.env.TEST_TIMEOUT = '9999';
    const cfg = loadConfigFile({ file: write('elastic:\n  timeout_ms: 1000\n') });
    cfg.get('elastic.timeout_ms', 'TEST_TIMEOUT', asInt, 15000);
    cfg.get('elastic.timeout_ms', 'TEST_TIMEOUT', asInt, 15000);

    expect(cfg.shadowed).toHaveLength(1);
  });
});

describe('${VAR} interpolation', () => {
  afterEach(() => {
    delete process.env.TEST_TOKEN;
    delete process.env.TEST_HOST;
  });

  test('pulls a secret in from the environment', () => {
    process.env.TEST_TOKEN = 'xoxb-real';
    const { get } = loadConfigFile({ file: write('slack:\n  bot_token: ${TEST_TOKEN}\n') });
    expect(get('slack.bot_token', 'SLACK_BOT_TOKEN', asIs, undefined)).toBe('xoxb-real');
  });

  test('${VAR:fallback} uses the fallback when the variable is unset', () => {
    const { get } = loadConfigFile({ file: write('slack:\n  bot_token: ${TEST_TOKEN:none}\n') });
    expect(get('slack.bot_token', 'SLACK_BOT_TOKEN', asIs, undefined)).toBe('none');
  });

  test('interpolates inside a larger string', () => {
    process.env.TEST_HOST = 'es.internal';
    const { get } = loadConfigFile({
      file: write('elastic:\n  elasticsearch_url: "https://${TEST_HOST}:9200"\n'),
    });
    expect(get('elastic.elasticsearch_url', 'ELASTICSEARCH_URL', asIs, undefined)).toBe(
      'https://es.internal:9200'
    );
  });

  /*
   * ${VAR} is for deployments that already inject secrets into the
   * environment. When the variable isn't there, the right behaviour is to
   * treat the setting as not configured and fall through - so that
   * config/validate.js reports "SLACK_BOT_TOKEN is required", which names the
   * thing the operator has to go and set, rather than the loader throwing a
   * parse error about a line they may not have written
   */
  /*
   * `bot_token: ${SLACK_BOT_TOKEN}` means "take it from the environment", so
   * it is not the file overriding anything. Counting it as shadowing would
   * fire a warning for every secret in the shipped example config, and a
   * warning that fires on a correct setup is a warning everyone learns to skip
   */
  test('a ${VAR} value is not reported as shadowing its own variable', () => {
    process.env.TEST_TOKEN = 'xoxb-real';
    const cfg = loadConfigFile({ file: write('slack:\n  bot_token: ${TEST_TOKEN}\n') });
    cfg.get('slack.bot_token', 'TEST_TOKEN', asIs, undefined);

    expect(cfg.shadowed).toEqual([]);
  });

  test('an unset ${VAR} falls through instead of throwing', () => {
    const cfg = loadConfigFile({ file: write('slack:\n  bot_token: ${TEST_TOKEN}\n') });
    expect(cfg.get('slack.bot_token', 'SLACK_BOT_TOKEN', asIs, 'the-default')).toBe('the-default');
    expect(cfg.unresolved).toContainEqual({ key: 'slack.bot_token', env: 'TEST_TOKEN' });
  });
});

describe('a missing or broken file', () => {
  test('no config file at all is fine - everything falls back to env and defaults', () => {
    const { get, file } = loadConfigFile({ file: null });
    expect(file).toBeNull();
    expect(get('elastic.timeout_ms', 'TEST_TIMEOUT', asInt, 15000)).toBe(15000);
  });

  test('malformed YAML names the file rather than dying somewhere downstream', () => {
    const bad = write('elastic:\n  timeout_ms: 1000\n   retries: 2\n');
    expect(() => loadConfigFile({ file: bad })).toThrow(ConfigFileError);
    expect(() => loadConfigFile({ file: bad })).toThrow(new RegExp(path.basename(bad)));
  });

  test('a top-level list is rejected - the file has to be a mapping', () => {
    expect(() => loadConfigFile({ file: write('- one\n- two\n') })).toThrow(ConfigFileError);
  });
});

/*
 * elastibot.yml holds every credential the bot has, so a mode that lets other
 * accounts on the host read it is worth saying out loud. `cp` inherits the
 * umask, which on most distributions is 0644 - so the insecure case is the
 * one that happens by default, not the one that takes effort.
 */
describe('file permissions', () => {
  const chmod = (mode) => {
    const f = write('elastic:\n  retries: 2\n');
    fs.chmodSync(f, mode);
    return f;
  };

  const onPosix = process.platform === 'win32' ? test.skip : test;

  onPosix('owner-only is silent', () => {
    expect(checkPermissions(chmod(0o600))).toBeNull();
    expect(checkPermissions(chmod(0o400))).toBeNull();
  });

  onPosix('group-readable is reported', () => {
    expect(checkPermissions(chmod(0o640))).toEqual({
      mode: '640',
      groupReadable: true,
      worldReadable: false,
    });
  });

  onPosix('what `cp` leaves behind by default is reported', () => {
    expect(checkPermissions(chmod(0o644))).toMatchObject({
      mode: '644',
      worldReadable: true,
    });
  });

  onPosix('the result rides along on the loader', () => {
    expect(loadConfigFile({ file: chmod(0o644) }).permissions.mode).toBe('644');
    expect(loadConfigFile({ file: chmod(0o600) }).permissions).toBeNull();
  });

  test('a file that is not there is not a permissions problem', () => {
    expect(checkPermissions(null)).toBeNull();
    expect(checkPermissions(path.join(dir, 'nope.yml'))).toBeNull();
  });
});