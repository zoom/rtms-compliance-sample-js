/**
 * Configuration, validated once at startup.
 *
 * Three rules this module exists to enforce:
 *
 * 1. Fail fast and fail loud. A missing variable is reported at boot with
 *    every offender named, not lazily at the first webhook when a live
 *    meeting is already being screened unscreened.
 * 2. Generate what only this process cares about; never invent a credential.
 *    Outside production, a missing signing secret is generated so the app can
 *    just run. Anything Zoom issues is still required, because a fabricated
 *    client secret turns a clear startup failure into a confusing 401 later.
 * 3. This is the only file in src/ allowed to contain a Zoom hostname.
 *    Everything else reads config.apiHost, so a Zoom for Government
 *    deployment is a single environment variable. A test enforces this.
 */
import crypto from 'node:crypto';

/** Thrown when the environment cannot produce a usable configuration. */
export class ConfigError extends Error {
  constructor(message, { missing = [] } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

/**
 * Required in production. Outside production, entries in GENERATED_IN_DEV and
 * DEV_DEFAULTS below are filled in before this list is checked.
 */
export const REQUIRED_ENV = [
  'ZM_RTMS_CLIENT',
  'ZM_RTMS_SECRET',
  'ZM_RTMS_WEBHOOK_SECRET',
  'DATABASE_URL',
  'PUBLIC_URL',
  'JWT_SECRET',
  'RULE_PACK_ID',
];

/**
 * Secrets this process both issues and verifies, so nothing outside it needs
 * to agree on the value. Safe to generate per boot in development.
 *
 * Deliberately excludes every Zoom credential. It also excludes anything used
 * to encrypt data at rest: an ephemeral key would silently make yesterday's
 * rows undecryptable, which is a worse failure than refusing to start.
 */
export const GENERATED_IN_DEV = ['JWT_SECRET'];

/**
 * Convenience defaults for local development. Each is a value a developer
 * would otherwise copy verbatim from the README.
 *
 * RULE_PACK_ID is intentionally absent. Which rules are in force is a
 * compliance decision, and it should never be implicit.
 */
const DEV_DEFAULTS = {
  DATABASE_URL: () => 'postgresql://compliance:compliance@localhost:5432/compliance',
  PUBLIC_URL: ({ port }) => `http://localhost:${port}`,
};

/**
 * Values that must never appear in a log line or a serialized config. They
 * are attached as non-enumerable properties, so JSON.stringify(config) and
 * console.log(config) omit them. Read them explicitly where needed.
 */
const SECRET_KEYS = ['zoomClientSecret', 'webhookSecret', 'jwtSecret', 'llmApiKey'];

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

/** Only the literal "true" enables a flag; anything else is off. */
function readFlag(env, name) {
  const raw = env[name];
  if (isBlank(raw)) return false;
  const value = String(raw).trim().toLowerCase();
  if (value !== 'true' && value !== 'false') {
    throw new ConfigError(`${name} must be "true" or "false", got: ${raw}`);
  }
  return value === 'true';
}

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
 * Does not log. Inspect `config.generatedSecrets` and warn from the caller, so
 * tests stay quiet and the warning appears once at boot.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {object} config with secrets attached non-enumerably
 */
export function loadConfig(env = process.env) {
  const isProduction = (env.NODE_ENV ?? 'development') === 'production';
  const resolved = { ...env };
  const generatedSecrets = [];

  const port = requireInt(resolved, 'PORT', 3000);

  if (!isProduction) {
    for (const name of GENERATED_IN_DEV) {
      if (isBlank(resolved[name])) {
        resolved[name] = crypto.randomBytes(32).toString('hex');
        generatedSecrets.push(name);
      }
    }

    for (const [name, build] of Object.entries(DEV_DEFAULTS)) {
      if (isBlank(resolved[name])) resolved[name] = build({ port });
    }
  }

  const missing = REQUIRED_ENV.filter((name) => isBlank(resolved[name]));
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}. See .env.example.`,
      { missing },
    );
  }

  // Tolerate a trailing slash; operators paste hosts from browsers.
  const zoomHost = (resolved.ZOOM_HOST?.trim() || DEFAULT_HOST).replace(/\/+$/, '');
  const hosts = HOST_MAP[zoomHost];
  if (!hosts) {
    throw new ConfigError(
      `ZOOM_HOST must be one of: ${Object.keys(HOST_MAP).join(', ')}. Got: ${zoomHost}`,
    );
  }

  const config = {
    isProduction,
    port,
    publicUrl: resolved.PUBLIC_URL.trim(),
    databaseUrl: resolved.DATABASE_URL.trim(),

    zoomHost,
    apiHost: hosts.apiHost,
    marketplaceHost: hosts.marketplaceHost,
    zoomClientId: resolved.ZM_RTMS_CLIENT.trim(),

    rulePackId: resolved.RULE_PACK_ID.trim(),
    rulePackDir: resolved.RULE_PACK_DIR?.trim() || 'rule-packs',
    transcriptLanguage: resolved.TRANSCRIPT_LANGUAGE?.trim() || 'ENGLISH',
    ruleSuppressionWindowSeconds: requireInt(resolved, 'RULE_SUPPRESSION_WINDOW_SECONDS', 60),

    // Off unless asked for. When off, alerts come from the rule pack alone and
    // nothing leaves the process for a model.
    adjudicationEnabled: readFlag(resolved, 'ADJUDICATION_ENABLED'),
    llmBaseUrl: resolved.LLM_BASE_URL?.trim() || 'https://openrouter.ai/api/v1',
    llmModel: resolved.LLM_MODEL?.trim() || 'anthropic/claude-sonnet-5',
    llmTimeoutMs: requireInt(resolved, 'LLM_TIMEOUT_MS', 5000),

    supervisorWebhookUrl: isBlank(resolved.SUPERVISOR_WEBHOOK_URL)
      ? undefined
      : resolved.SUPERVISOR_WEBHOOK_URL.trim(),
    rtmsProxyUrl: isBlank(resolved.RTMS_PROXY_URL) ? undefined : resolved.RTMS_PROXY_URL.trim(),

    /** Names only, never values. The caller warns about these at boot. */
    generatedSecrets,
  };

  const secrets = {
    zoomClientSecret: resolved.ZM_RTMS_SECRET,
    webhookSecret: resolved.ZM_RTMS_WEBHOOK_SECRET,
    jwtSecret: resolved.JWT_SECRET,
    // Used only when ADJUDICATION_ENABLED=true.
    llmApiKey: isBlank(resolved.LLM_API_KEY) ? undefined : resolved.LLM_API_KEY,
  };

  // Enabling adjudication without a key would fail on every alert. A keyless
  // local model server can be given any placeholder.
  if (config.adjudicationEnabled && !secrets.llmApiKey) {
    throw new ConfigError('ADJUDICATION_ENABLED=true requires LLM_API_KEY', {
      missing: ['LLM_API_KEY'],
    });
  }

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
