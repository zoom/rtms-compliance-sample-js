import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, ConfigError, REQUIRED_ENV, GENERATED_IN_DEV } from '../../src/config.js';

// Acceptance criteria 49-50 and 55-60, plus the ZfG host derivation.

// Production is the strict case: nothing is generated, nothing is defaulted.
// Development behavior gets its own describe block below.
const validEnv = (overrides = {}) => ({
  NODE_ENV: 'production',
  ZM_RTMS_CLIENT: 'client-id',
  ZM_RTMS_SECRET: 'client-secret',
  ZM_RTMS_WEBHOOK_SECRET: 'webhook-secret',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  PUBLIC_URL: 'https://example.ngrok-free.app',
  JWT_SECRET: 'b'.repeat(64),
  RULE_PACK_ID: 'fin-us-retail-v4',
  LLM_API_KEY: 'llm-key',
  ...overrides,
});

/** Development environment: only the values Zoom issues are supplied. */
const devEnv = (overrides = {}) => ({
  NODE_ENV: 'development',
  ZM_RTMS_CLIENT: 'client-id',
  ZM_RTMS_SECRET: 'client-secret',
  ZM_RTMS_WEBHOOK_SECRET: 'webhook-secret',
  RULE_PACK_ID: 'fin-us-retail-v4',
  ...overrides,
});

describe('loadConfig', () => {
  test('should load a complete environment without throwing', () => {
    const config = loadConfig(validEnv());

    assert.equal(config.rulePackId, 'fin-us-retail-v4');
  });

  test('should throw ConfigError listing every missing required variable', () => {
    const env = validEnv();
    delete env.ZM_RTMS_CLIENT;
    delete env.DATABASE_URL;

    assert.throws(
      () => loadConfig(env),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.deepEqual(err.missing.sort(), ['DATABASE_URL', 'ZM_RTMS_CLIENT']);
        return true;
      },
    );
  });

  test('should name the missing variables in the error message', () => {
    const env = validEnv();
    delete env.JWT_SECRET;

    assert.throws(() => loadConfig(env), /JWT_SECRET/);
  });

  test('should treat an empty string as missing', () => {
    assert.throws(() => loadConfig(validEnv({ ZM_RTMS_SECRET: '' })), ConfigError);
  });

  test('should treat a whitespace-only value as missing', () => {
    assert.throws(() => loadConfig(validEnv({ ZM_RTMS_SECRET: '   ' })), ConfigError);
  });

  test('should declare every required variable in REQUIRED_ENV', () => {
    assert.ok(Array.isArray(REQUIRED_ENV));
    for (const name of REQUIRED_ENV) {
      assert.ok(name in validEnv(), `REQUIRED_ENV names ${name}, which the valid fixture lacks`);
    }
  });

  test('should not require a variable the application never reads', () => {
    // Requiring a secret nothing consumes trains developers to generate
    // values that do not matter, which devalues the ones that do.
    for (const name of REQUIRED_ENV) {
      assert.ok(
        !['SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY'].includes(name),
        `${name} is required but unused; drop it until something reads it`,
      );
    }
  });

  test('should treat LLM_API_KEY as optional', () => {
    // OpenRouter serves free models without a key, and a failed adjudication
    // degrades to an unadjudicated alert rather than losing it.
    const env = validEnv();
    delete env.LLM_API_KEY;

    const config = loadConfig(env);
    assert.equal(config.llmApiKey, undefined);
  });
});

describe('development secret generation', () => {
  test('should generate a missing JWT_SECRET outside production', () => {
    const config = loadConfig(devEnv());

    assert.match(config.jwtSecret, /^[0-9a-f]{64}$/);
  });

  test('should report which secrets it generated', () => {
    const config = loadConfig(devEnv());

    assert.deepEqual(config.generatedSecrets, ['JWT_SECRET']);
  });

  test('should generate a different secret on every load', () => {
    const first = loadConfig(devEnv());
    const second = loadConfig(devEnv());

    assert.notEqual(first.jwtSecret, second.jwtSecret);
  });

  test('should never overwrite a secret the developer supplied', () => {
    const config = loadConfig(devEnv({ JWT_SECRET: 'b'.repeat(64) }));

    assert.equal(config.jwtSecret, 'b'.repeat(64));
    assert.deepEqual(config.generatedSecrets, []);
  });

  test('should still require the secret in production', () => {
    const env = validEnv();
    delete env.JWT_SECRET;

    assert.throws(() => loadConfig(env), ConfigError);
  });

  test('should treat an unset NODE_ENV as development', () => {
    const env = devEnv();
    delete env.NODE_ENV;

    assert.doesNotThrow(() => loadConfig(env));
  });

  test('should only generate values listed in GENERATED_IN_DEV', () => {
    // Anything Zoom issues cannot be invented. Generating a placeholder for a
    // credential would turn a clear startup failure into a confusing 401.
    assert.deepEqual(GENERATED_IN_DEV, ['JWT_SECRET']);
    for (const name of ['ZM_RTMS_CLIENT', 'ZM_RTMS_SECRET', 'ZM_RTMS_WEBHOOK_SECRET']) {
      assert.ok(!GENERATED_IN_DEV.includes(name));
    }
  });

  test('should still fail when a Zoom-issued credential is missing in development', () => {
    const env = devEnv();
    delete env.ZM_RTMS_SECRET;

    assert.throws(
      () => loadConfig(env),
      (err) => {
        assert.deepEqual(err.missing, ['ZM_RTMS_SECRET']);
        return true;
      },
    );
  });

  test('should still require an explicit rule pack in development', () => {
    // Defaulting a rule pack is the one convenience this app should not offer.
    // Which rules are in force is a compliance decision, never an implicit one.
    const env = devEnv();
    delete env.RULE_PACK_ID;

    assert.throws(() => loadConfig(env), ConfigError);
  });
});

describe('development defaults', () => {
  test('should default DATABASE_URL to the compose Postgres', () => {
    const config = loadConfig(devEnv());

    assert.match(config.databaseUrl, /^postgresql:\/\/.+@(localhost|127\.0\.0\.1):5432\//);
  });

  test('should default PUBLIC_URL to localhost on the configured port', () => {
    const config = loadConfig(devEnv({ PORT: '4000' }));

    assert.equal(config.publicUrl, 'http://localhost:4000');
  });

  test('should require DATABASE_URL in production', () => {
    const env = validEnv();
    delete env.DATABASE_URL;

    assert.throws(() => loadConfig(env), ConfigError);
  });

  test('should require PUBLIC_URL in production', () => {
    const env = validEnv();
    delete env.PUBLIC_URL;

    assert.throws(() => loadConfig(env), ConfigError);
  });

  test('should prefer a supplied value over a development default', () => {
    const config = loadConfig(devEnv({ PUBLIC_URL: 'https://mine.ngrok-free.app' }));

    assert.equal(config.publicUrl, 'https://mine.ngrok-free.app');
  });
});

describe('Zoom for Government host derivation', () => {
  test('should default ZOOM_HOST to commercial Zoom', () => {
    const config = loadConfig(validEnv());

    assert.equal(config.zoomHost, 'https://zoom.us');
  });

  test('should derive commercial api and marketplace hosts', () => {
    const config = loadConfig(validEnv({ ZOOM_HOST: 'https://zoom.us' }));

    assert.equal(config.apiHost, 'https://api.zoom.us');
    assert.equal(config.marketplaceHost, 'https://marketplace.zoom.us');
  });

  test('should derive government api and marketplace hosts', () => {
    const config = loadConfig(validEnv({ ZOOM_HOST: 'https://zoomgov.com' }));

    assert.equal(config.zoomHost, 'https://zoomgov.com');
    assert.equal(config.apiHost, 'https://api.zoomgov.com');
    assert.equal(config.marketplaceHost, 'https://marketplace.zoomgov.com');
  });

  test('should reject an unrecognized ZOOM_HOST rather than guessing', () => {
    assert.throws(
      () => loadConfig(validEnv({ ZOOM_HOST: 'https://zoom.example.com' })),
      ConfigError,
    );
  });

  test('should tolerate a trailing slash on ZOOM_HOST', () => {
    const config = loadConfig(validEnv({ ZOOM_HOST: 'https://zoomgov.com/' }));

    assert.equal(config.apiHost, 'https://api.zoomgov.com');
  });
});

describe('adjudication flag', () => {
  test('should default to off', () => {
    assert.equal(loadConfig(validEnv()).adjudicationEnabled, false);
  });

  test('should turn on only for "true"', () => {
    const config = loadConfig(validEnv({ ADJUDICATION_ENABLED: 'true', LLM_API_KEY: 'sk-test' }));
    assert.equal(config.adjudicationEnabled, true);
  });

  test('should refuse to start when on without a key', () => {
    assert.throws(
      () => loadConfig(validEnv({ ADJUDICATION_ENABLED: 'true', LLM_API_KEY: '' })),
      ConfigError,
    );
  });

  test('should reject a value that is not true or false', () => {
    assert.throws(() => loadConfig(validEnv({ ADJUDICATION_ENABLED: 'yes' })), ConfigError);
  });
});

describe('tunable defaults', () => {
  test('should default the suppression window to 60 seconds', () => {
    assert.equal(loadConfig(validEnv()).ruleSuppressionWindowSeconds, 60);
  });

  test('should default the transcript language to ENGLISH', () => {
    // An explicit source language skips the SDK's ~30s auto-detect, which
    // would otherwise leave the opening of the call unscreened.
    assert.equal(loadConfig(validEnv()).transcriptLanguage, 'ENGLISH');
  });

  test('should parse numeric overrides as numbers', () => {
    const config = loadConfig(validEnv({ RULE_SUPPRESSION_WINDOW_SECONDS: '90' }));

    assert.equal(config.ruleSuppressionWindowSeconds, 90);
  });

  test('should reject a non-numeric override rather than falling back silently', () => {
    assert.throws(
      () => loadConfig(validEnv({ RULE_SUPPRESSION_WINDOW_SECONDS: 'sixty' })),
      ConfigError,
    );
  });

  test('should leave the supervisor webhook undefined when unset', () => {
    assert.equal(loadConfig(validEnv()).supervisorWebhookUrl, undefined);
  });
});

describe('credential hygiene', () => {
  test('should not expose raw secrets on the stringified config', () => {
    const config = loadConfig(validEnv());

    const serialized = JSON.stringify(config);
    assert.ok(!serialized.includes('client-secret'), 'client secret must not serialize');
    assert.ok(!serialized.includes('webhook-secret'), 'webhook secret must not serialize');
  });
});
