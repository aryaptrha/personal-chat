import dotenv from 'dotenv';

dotenv.config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const rawBaseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
// Automatically ensure OpenAI base URL ends with /v1 if missing
const normalizedBaseUrl = rawBaseUrl.endsWith('/v1') || rawBaseUrl.endsWith('/v1/')
  ? rawBaseUrl
  : `${rawBaseUrl.replace(/\/$/, '')}/v1`;

/**
 * Browsers send `Origin` without a trailing slash, so normalise the allowlist
 * the same way. Entries that aren't parseable absolute origins fail loudly at
 * startup rather than silently never matching.
 */
function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];

  const parsed: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    try {
      // new URL() normalises casing and strips any path or trailing slash.
      parsed.push(new URL(trimmed).origin);
    } catch {
      throw new Error(
        `Invalid CORS_ORIGIN entry: "${trimmed}". Use a full origin, e.g. https://example.com`
      );
    }
  }

  return [...new Set(parsed)];
}

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${name}: "${raw}" is not an integer.`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}: ${parsed} is outside the allowed range ${min}-${max}.`);
  }

  return parsed;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

export const config = {
  nodeEnv,
  isProduction,
  port: intFromEnv('PORT', 3000, 1, 65535),

  llmApiKey: process.env.LLM_API_KEY || '',
  llmBaseUrl: normalizedBaseUrl,
  llmModel: process.env.LLM_MODEL || 'gpt-4o-mini',

  /**
   * Allowlisted browser origins. An empty array means "no browser origin is
   * allowed" — deliberately fail-closed. There is no '*' fallback, because a
   * missing env var in production used to silently open the API to every site.
   */
  corsOrigins: parseOrigins(process.env.CORS_ORIGIN),

  /**
   * Number of reverse proxies in front of the app, used for Express
   * `trust proxy`. Render terminates TLS at its own edge proxy, so 1 is correct
   * for a plain *.onrender.com service. Putting Cloudflare in front of the API
   * hostname as well makes it 2.
   *
   * This must be a hop COUNT, never `true`. With `true`, Express reads the
   * leftmost X-Forwarded-For entry, which the client fully controls — every
   * rate limit could then be bypassed by sending a fresh fake IP per request.
   */
  trustProxyHops: intFromEnv('TRUST_PROXY_HOPS', 1, 0, 10),

  useDummyMode: boolFromEnv('USE_DUMMY_MODE', false) || !process.env.LLM_API_KEY,

  /**
   * Optional shared secret. When set, /api requests must present it in the
   * `X-API-Key` header. Only worth anything if the caller can actually keep it
   * secret, i.e. a Cloudflare Worker/Function proxy — never inline it in the
   * Vue bundle, where anyone can read it from devtools.
   */
  apiSharedSecret: process.env.API_SHARED_SECRET?.trim() || '',

  /**
   * Optional Cloudflare Turnstile secret. When set, /api/chat requires a session
   * token obtained from POST /api/session with a valid Turnstile response.
   */
  turnstileSecretKey: process.env.TURNSTILE_SECRET_KEY?.trim() || '',

  /**
   * HMAC key for session tokens. Falls back to a per-boot random key, which is
   * fine for a single Render instance but invalidates outstanding tokens on
   * every restart and deploy — set it explicitly to avoid that.
   */
  sessionTokenSecret: process.env.SESSION_TOKEN_SECRET?.trim() || '',

  /** How long a session token stays valid. */
  sessionTtlMs: intFromEnv('SESSION_TTL_MINUTES', 60, 1, 1440) * 60 * 1000,

  /**
   * Escape hatch for local prompt experiments. When false (the default), any
   * client-supplied `system` message is discarded so the server-side persona
   * prompt can never be replaced.
   */
  allowClientSystemPrompt: boolFromEnv('ALLOW_CLIENT_SYSTEM_PROMPT', false),

  rateLimit: {
    windowMs: intFromEnv('RATE_LIMIT_WINDOW_MINUTES', 15, 1, 1440) * 60 * 1000,
    /** Ceiling for all /api traffic, cheap endpoints included. */
    max: intFromEnv('RATE_LIMIT_MAX_REQUESTS', 60, 1, 10_000),
    /** Tighter ceiling for /api/chat, the only endpoint that costs money. */
    chatMax: intFromEnv('RATE_LIMIT_CHAT_MAX_REQUESTS', 20, 1, 10_000),
    /** Short burst window so one client can't fire the whole quota at once. */
    burstWindowMs: intFromEnv('RATE_LIMIT_BURST_WINDOW_SECONDS', 10, 1, 3600) * 1000,
    burstMax: intFromEnv('RATE_LIMIT_BURST_MAX_REQUESTS', 3, 1, 100),
  },

  limits: {
    /** Enforced before JSON parsing, so oversized bodies never reach the heap. */
    jsonBodyLimit: process.env.JSON_BODY_LIMIT?.trim() || '64kb',
    maxMessages: intFromEnv('MAX_MESSAGES_PER_REQUEST', 24, 1, 200),
    maxMessageChars: intFromEnv('MAX_MESSAGE_CHARS', 4_000, 1, 100_000),
    maxTotalChars: intFromEnv('MAX_TOTAL_CHARS', 12_000, 1, 500_000),
    maxOutputTokens: intFromEnv('MAX_OUTPUT_TOKENS', 512, 16, 8_192),
    minTemperature: 0,
    maxTemperature: 1.2,
    defaultTemperature: 0.95,
    /** Upstream LLM timeout — stops a hung provider from holding sockets open. */
    llmTimeoutMs: intFromEnv('LLM_TIMEOUT_SECONDS', 60, 5, 300) * 1000,
  },
};

/**
 * Startup gate. Anything that would make the deployment quietly insecure is a
 * hard failure in production and a visible warning in development, so problems
 * surface at deploy time instead of in the logs three weeks later.
 */
export function validateConfig(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (config.corsOrigins.length === 0) {
    const message =
      'CORS_ORIGIN is not set, so no browser origin will be allowed. ' +
      'Set it to your frontend origin, e.g. https://yourapp.pages.dev';
    if (config.isProduction) errors.push(message);
    else warnings.push(`${message} (tolerated in development only)`);
  }

  for (const origin of config.corsOrigins) {
    if (config.isProduction && origin.startsWith('http://') && !origin.includes('localhost')) {
      warnings.push(`CORS origin ${origin} is plain HTTP; prefer HTTPS in production.`);
    }
  }

  if (config.isProduction && config.useDummyMode) {
    warnings.push(
      'Running in DUMMY MODE in production — LLM_API_KEY is missing or USE_DUMMY_MODE=true.'
    );
  }

  if (config.allowClientSystemPrompt) {
    const message =
      'ALLOW_CLIENT_SYSTEM_PROMPT=true lets callers replace the persona system prompt, ' +
      'which turns this service into an open LLM proxy billed to your API key.';
    if (config.isProduction) errors.push(message);
    else warnings.push(message);
  }

  if (config.apiSharedSecret && config.apiSharedSecret.length < 24) {
    errors.push('API_SHARED_SECRET is too short; use at least 24 random characters.');
  }

  if (config.limits.maxTotalChars < config.limits.maxMessageChars) {
    warnings.push(
      'MAX_TOTAL_CHARS is below MAX_MESSAGE_CHARS, so a single full-length message can never pass.'
    );
  }

  for (const warning of warnings) {
    console.warn(`⚠️  ${warning}`);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`❌ ${error}`);
    }
    throw new Error(`Refusing to start with ${errors.length} insecure configuration value(s).`);
  }

  if (config.useDummyMode) {
    console.log(
      '💡 Running in DUMMY MODE (mock AI responses). Set USE_DUMMY_MODE=false and provide LLM_API_KEY for real LLM integration.'
    );
  }
}
