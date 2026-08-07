'use strict';

const { validateConfig } = require('../config/validate');

/*
 * Config validation is the only thing standing between a typo in .env and a
 * bot that starts fine and then fails on the first real alert. The
 * collect-everything behaviour is deliberate: an operator should get one round
 * of mistakes, not one mistake per restart
 */

describe('config validation', () => {
  /** A config that passes, which each test then breaks in one specific way */
  const valid = () => ({
    shutdownTimeoutMs: 15000,
    slack: {
      botToken: 'xoxb-test',
      signingSecret: 'sekrit',
      appToken: 'xapp-test',
      socketMode: true,
      port: 3000,
    },
    elastic: {
      kibanaUrl: 'https://kibana.internal:5601',
      kibanaPublicUrl: 'https://kibana.example.com',
      esUrl: 'https://es.internal:9200',
      serviceApiKey: 'service-key',
      tlsRejectUnauthorized: true,
      requestTimeoutMs: 15000,
      maxSockets: 50,
      maxResponseBytes: 52428800,
      alertsIndex: '.alerts-security.alerts-*',
      defaultOwner: 'securitySolution',
      retries: 2,
      retryBaseDelayMs: 250,
    },
    security: {
      encryptionKey: 'a-long-enough-test-secret-0123456789',
      userStorePath: './data/users.json',
      statePath: './data/state.json',
    },
    cache: {
      spaceNameTtlMs: 3600000,
      clientTtlMs: 900000,
      maxClients: 250,
      userTtlMs: 300000,
    },
    grouping: { windowMs: 3600000, maxAlertsPerCase: 200 },
    naming: { truncateRuleWords: null, timeZone: 'UTC' },
    logging: { level: 'silent', format: 'json', redact: true },
    stats: {
      defaultWindow: '7d',
      maxWindowDays: 90,
      timeZone: 'UTC',
      topN: 10,
      noiseMinAlerts: 10,
      processField: 'process.name',
    },
    watchers: {
      enabled: true,
      pollIntervalMs: 60000,
      jitterRatio: 0.1,
      fetchSize: 200,
      postDelayMs: 300,
      defaultChannel: 'C1',
      channelRouting: {},
      alerts: { enabled: true },
      cases: { enabled: true, spaces: ['default'], perPage: 25 },
    },
  });

  const check = (mutate) => {
    const cfg = valid();
    mutate(cfg);
    return validateConfig(cfg, { throwOnError: false });
  };

  test('a good config produces no errors', () => {
    expect(validateConfig(valid(), { throwOnError: false }).errors).toEqual([]);
  });

  test('every missing required value is reported at once, not just the first', () => {
    const { errors } = check((c) => {
      c.slack.botToken = undefined;
      c.slack.signingSecret = undefined;
      c.elastic.kibanaUrl = undefined;
    });
    expect(errors).toHaveLength(3);
  });

  test('a malformed URL is caught at boot instead of at first use', () => {
    const { errors } = check((c) => { c.elastic.esUrl = 'es.internal:9200'; });
    expect(errors.join()).toMatch(/ELASTICSEARCH_URL/);
  });

  test('a bad timezone is caught at boot', () => {
    const { errors } = check((c) => { c.stats.timeZone = 'America/Nowhere'; });
    expect(errors.join()).toMatch(/STATS_TIMEZONE/);
  });

  test('an unencrypted key store is a warning, not a hard failure', () => {
    const { errors, warnings } = check((c) => { c.security.encryptionKey = undefined; });
    expect(errors).toEqual([]);
    expect(warnings.join()).toMatch(/ELASTIBOT_SECRET_KEY/);
  });

  test('watchers enabled without a service key warns rather than dying', () => {
    const { errors, warnings } = check((c) => { c.elastic.serviceApiKey = undefined; });
    expect(errors).toEqual([]);
    expect(warnings.join()).toMatch(/watchers will not run/);
  });

  test('a rate-limit-inviting post delay is flagged', () => {
    const { warnings } = check((c) => { c.watchers.postDelayMs = 0; });
    expect(warnings.join()).toMatch(/rate limit/);
  });

  test('validateConfig throws a ConfigError listing everything', () => {
    const cfg = valid();
    cfg.slack.botToken = undefined;
    cfg.elastic.esUrl = undefined;
    expect(() => validateConfig(cfg)).toThrow(/SLACK_BOT_TOKEN[\s\S]*ELASTICSEARCH_URL/);
  });
});