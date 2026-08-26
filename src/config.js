/**
 * Configuration, validated once at startup.
 *
 * Two rules this module exists to enforce:
 *
 * 1. Fail fast and fail loud. A missing variable is reported at boot with
 *    every offender named, not lazily at the first webhook when a live
 *    meeting is already being screened unscreened.
 * 2. This is the only file in src/ allowed to contain a Zoom hostname.
 *    Everything else reads config.apiHost, so a Zoom for Government
 *    deployment is a single environment variable. A test enforces this.
 */

/** Thrown when the environment cannot produce a usable configuration. */
export class ConfigError extends Error {
  constructor(message, { missing = [] } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

export const REQUIRED_ENV = [
  'ZM_RTMS_CLIENT',
  'ZM_RTMS_SECRET',
  'ZM_RTMS_WEBHOOK_SECRET',
  'DATABASE_URL',
  'PUBLIC_URL',
  'SESSION_SECRET',
  'JWT_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'RULE_PACK_ID',
  'LLM_API_KEY',
];

/**
 * Values that must never appear in a log line or a serialized config. They
 * are attached as non-enumerable properties, so JSON.stringify(config) and
 * console.log(config) omit them. Read them explicitly where needed.
 */
const SECRET_KEYS = [
  'zoomClientSecret',
  'webhookSecret',
  'sessionSecret',
  'jwtSecret',
  'tokenEncryptionKey',
  'llmApiKey',
];

// Commercial and government hosts. Anything else is a typo, and guessing at a
// derived api host from an unknown domain would fail at request time instead.
const HOST_MAP = {
  'https://zoom.us': {
    apiHost: 'https://api.zoom.us',
    marketplaceHost: 'https://marketplace.zoom.us',
  },
  'https://zoomgov.com': {
    apiHost: 'https://api.zoomgov.com',
    marketplaceHost: 'https://marketplace.zoomgov.com',
  },
};

const DEFAULT_HOST = 'https://zoom.us';

const isBlank = (value) => value == null || String(value).trim() === '';

function requireInt(env, name, fallback) {
  const raw = env[name];
  if (isBlank(raw)) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

/**
 * Build the application configuration from an environment object.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {object} config with secrets attached non-enumerably
 */
export function loadConfig(env = process.env) {
  const missing = REQUIRED_ENV.filter((name) => isBlank(env[name]));
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}. See .env.example.`,
      { missing },
    );
  }

  // Tolerate a trailing slash; operators paste hosts from browsers.
  const zoomHost = (env.ZOOM_HOST?.trim() || DEFAULT_HOST).replace(/\/+$/, '');
  const hosts = HOST_MAP[zoomHost];
  if (!hosts) {
    throw new ConfigError(
      `ZOOM_HOST must be one of: ${Object.keys(HOST_MAP).join(', ')}. Got: ${zoomHost}`,
    );
  }

  const config = {
    port: requireInt(env, 'PORT', 3000),
    publicUrl: env.PUBLIC_URL.trim(),
    databaseUrl: env.DATABASE_URL.trim(),

    zoomHost,
    apiHost: hosts.apiHost,
    marketplaceHost: hosts.marketplaceHost,
    zoomClientId: env.ZM_RTMS_CLIENT.trim(),

    rulePackId: env.RULE_PACK_ID.trim(),
    rulePackDir: env.RULE_PACK_DIR?.trim() || 'rule-packs',
    transcriptLanguage: env.TRANSCRIPT_LANGUAGE?.trim() || 'ENGLISH',
    ruleSuppressionWindowSeconds: requireInt(env, 'RULE_SUPPRESSION_WINDOW_SECONDS', 60),
    disclosureIntervalSeconds: requireInt(env, 'DISCLOSURE_INTERVAL_SECONDS', 20),

    llmBaseUrl: env.LLM_BASE_URL?.trim() || 'https://openrouter.ai/api/v1',
    llmModel: env.LLM_MODEL?.trim() || 'anthropic/claude-sonnet-5',
    llmTimeoutMs: requireInt(env, 'LLM_TIMEOUT_MS', 5000),

    supervisorWebhookUrl: isBlank(env.SUPERVISOR_WEBHOOK_URL)
      ? undefined
      : env.SUPERVISOR_WEBHOOK_URL.trim(),
    rtmsProxyUrl: isBlank(env.RTMS_PROXY_URL) ? undefined : env.RTMS_PROXY_URL.trim(),
  };

  const secrets = {
    zoomClientSecret: env.ZM_RTMS_SECRET,
    webhookSecret: env.ZM_RTMS_WEBHOOK_SECRET,
    sessionSecret: env.SESSION_SECRET,
    jwtSecret: env.JWT_SECRET,
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    llmApiKey: env.LLM_API_KEY,
  };

  for (const key of SECRET_KEYS) {
    Object.defineProperty(config, key, {
      value: secrets[key],
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  return config;
}
