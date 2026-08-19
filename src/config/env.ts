import dotenv from 'dotenv';

dotenv.config();

function getNormalizedBaseUrl(raw: string | undefined): string {
  const url = raw || 'https://api.openai.com/v1';
  return url.endsWith('/v1') || url.endsWith('/v1/')
    ? url
    : `${url.replace(/\/$/, '')}/v1`;
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];

  const parsed: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    try {
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

let cachedOriginsRaw: string | undefined = undefined;
let cachedOrigins: string[] = [];
let cachedOriginsSet: Set<string> = new Set();

function getParsedOrigins(raw: string | undefined): { origins: string[]; originsSet: Set<string> } {
  if (raw === cachedOriginsRaw) {
    return { origins: cachedOrigins, originsSet: cachedOriginsSet };
  }

  cachedOriginsRaw = raw;
  cachedOrigins = parseOrigins(raw);
  cachedOriginsSet = new Set(cachedOrigins);
  return { origins: cachedOrigins, originsSet: cachedOriginsSet };
}

export const config = {
  get nodeEnv(): string {
    return process.env.NODE_ENV || 'development';
  },
  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  },
  get port(): number {
    return intFromEnv('PORT', 3000, 1, 65535);
  },

  get llmApiKey(): string {
    return process.env.LLM_API_KEY || '';
  },
  get llmBaseUrl(): string {
    return getNormalizedBaseUrl(process.env.LLM_BASE_URL);
  },
  get llmModel(): string {
    return process.env.LLM_MODEL || 'gpt-4o-mini';
  },

  get corsOrigins(): string[] {
    return getParsedOrigins(process.env.CORS_ORIGIN).origins;
  },

  get corsOriginsSet(): Set<string> {
    return getParsedOrigins(process.env.CORS_ORIGIN).originsSet;
  },

  get trustProxyHops(): number {
    return intFromEnv('TRUST_PROXY_HOPS', 1, 0, 10);
  },

  get useDummyMode(): boolean {
    return boolFromEnv('USE_DUMMY_MODE', false) || !this.llmApiKey;
  },

  get apiSharedSecret(): string {
    return process.env.API_SHARED_SECRET?.trim() || '';
  },

  get turnstileSecretKey(): string {
    return process.env.TURNSTILE_SECRET_KEY?.trim() || '';
  },

  get sessionTokenSecret(): string {
    return process.env.SESSION_TOKEN_SECRET?.trim() || '';
  },

  get sessionTtlMs(): number {
    return intFromEnv('SESSION_TTL_MINUTES', 60, 1, 1440) * 60 * 1000;
  },

  get allowClientSystemPrompt(): boolean {
    return boolFromEnv('ALLOW_CLIENT_SYSTEM_PROMPT', false);
  },

  get rateLimit() {
    return {
      windowMs: intFromEnv('RATE_LIMIT_WINDOW_MINUTES', 15, 1, 1440) * 60 * 1000,
      max: intFromEnv('RATE_LIMIT_MAX_REQUESTS', 120, 1, 50_000),
      chatMax: intFromEnv('RATE_LIMIT_CHAT_MAX_REQUESTS', 40, 1, 50_000),
      burstWindowMs: intFromEnv('RATE_LIMIT_BURST_WINDOW_SECONDS', 10, 1, 3600) * 1000,
      burstMax: intFromEnv('RATE_LIMIT_BURST_MAX_REQUESTS', 10, 1, 500),
    };
  },

  get limits() {
    return {
      jsonBodyLimit: process.env.JSON_BODY_LIMIT?.trim() || '64kb',
      maxMessages: intFromEnv('MAX_MESSAGES_PER_REQUEST', 24, 1, 200),
      maxMessageChars: intFromEnv('MAX_MESSAGE_CHARS', 4_000, 1, 100_000),
      maxTotalChars: intFromEnv('MAX_TOTAL_CHARS', 12_000, 1, 500_000),
      maxOutputTokens: intFromEnv('MAX_OUTPUT_TOKENS', 512, 16, 8_192),
      minTemperature: 0,
      maxTemperature: 1.2,
      defaultTemperature: 0.95,
      llmTimeoutMs: intFromEnv('LLM_TIMEOUT_SECONDS', 60, 5, 300) * 1000,
    };
  },
};

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
    console.warn(`⚠️ Configuration validation issue(s) detected: ${errors.length} value(s). Configure secrets via Wrangler if needed.`);
  }

  if (config.useDummyMode) {
    console.log(
      '💡 Running in DUMMY MODE (mock AI responses). Set USE_DUMMY_MODE=false and provide LLM_API_KEY for real LLM integration.'
    );
  }
}
