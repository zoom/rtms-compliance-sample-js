import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, ConfigError, REQUIRED_ENV } from '../../src/config.js';

// Acceptance criteria 49-50, plus the ZfG host derivation.

const validEnv = (overrides = {}) => ({
  ZM_RTMS_CLIENT: 'client-id',
  ZM_RTMS_SECRET: 'client-secret',
  ZM_RTMS_WEBHOOK_SECRET: 'webhook-secret',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  PUBLIC_URL: 'https://example.ngrok-free.app',
  SESSION_SECRET: 'a'.repeat(64),
  JWT_SECRET: 'b'.repeat(64),
  TOKEN_ENCRYPTION_KEY: 'c'.repeat(64),
  RULE_PACK_ID: 'fin-us-retail-v3',
  LLM_API_KEY: 'llm-key',
  ...overrides,
});

describe('loadConfig', () => {
  test('should load a complete environment without throwing', () => {
    const config = loadConfig(validEnv());

    assert.equal(config.rulePackId, 'fin-us-retail-v3');
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
    for (const name of Object.keys(validEnv())) {
      // Every key in a known-valid environment is either required or optional,
      // but the required list must not reference anything unknown.
      assert.equal(typeof name, 'string');
    }
    for (const name of REQUIRED_ENV) {
      assert.ok(name in validEnv(), `REQUIRED_ENV names ${name}, which the valid fixture lacks`);
    }
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
    assert.throws(() => loadConfig(validEnv({ ZOOM_HOST: 'https://zoom.example.com' })), ConfigError);
  });

  test('should tolerate a trailing slash on ZOOM_HOST', () => {
    const config = loadConfig(validEnv({ ZOOM_HOST: 'https://zoomgov.com/' }));

    assert.equal(config.apiHost, 'https://api.zoomgov.com');
  });
});

describe('tunable defaults', () => {
  test('should default the suppression window to 60 seconds', () => {
    assert.equal(loadConfig(validEnv()).ruleSuppressionWindowSeconds, 60);
  });

  test('should default the disclosure interval to 20 seconds', () => {
    assert.equal(loadConfig(validEnv()).disclosureIntervalSeconds, 20);
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
      () => loadConfig(validEnv({ DISCLOSURE_INTERVAL_SECONDS: 'twenty' })),
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
