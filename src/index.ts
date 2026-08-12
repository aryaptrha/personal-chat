import { Hono } from 'hono';
import { config, validateConfig } from './config/env.js';
import { chatRouter } from './routes/chat.js';
import { apiRateLimiter } from './middleware/rateLimiter.js';
import { originGuard } from './middleware/originGuard.js';
import { sharedSecretGuard } from './middleware/sharedSecret.js';
import { noStore, requestId, securityHeaders } from './middleware/securityHeaders.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { turnstileEnabled } from './middleware/turnstile.js';
import type { Env } from './types/hono.js';

validateConfig();

const app = new Hono<Env>();

app.use('*', requestId);
app.use('*', securityHeaders);

app.use('*', async (c, next) => {
  const allowedOrigins = config.corsOrigins;
  const origin = c.req.header('origin');

  if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
    c.header('Access-Control-Allow-Origin', origin);
  }

  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Session-Token, X-API-Key'
  );
  c.header(
    'Access-Control-Expose-Headers',
    'X-Request-Id, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset'
  );
  c.header('Access-Control-Max-Age', '600');

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  await next();
});

// Health Check Endpoint (Unthrottled)
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
const api = new Hono<Env>();
api.use('*', noStore);
api.use('*', sharedSecretGuard);
api.use('*', originGuard);
api.use('*', apiRateLimiter);

api.route('/', chatRouter);

app.route('/api', api);

app.notFound(notFoundHandler);
app.onError(errorHandler);

console.log(`🚀 Chatbot backend initialized for Cloudflare Workers`);
console.log(`🎯 Configured LLM Base URL: ${config.llmBaseUrl}`);
console.log(`🤖 Configured LLM Model: ${config.llmModel}`);
console.log(
  `🔒 Allowed origins: ${
    config.corsOrigins.length > 0
      ? config.corsOrigins.join(', ')
      : '(none — development reflects caller)'
  }`
);
console.log(
  `🛡️  Shared secret: ${config.apiSharedSecret ? 'required' : 'off'} | ` +
    `Turnstile: ${turnstileEnabled() ? 'required' : 'off'}`
);

export default app;
