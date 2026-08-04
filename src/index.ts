import express from 'express';
import cors, { CorsOptions } from 'cors';
import { config, validateConfig } from './config/env.js';
import { chatRouter } from './routes/chat.js';
import { apiRateLimiter } from './middleware/rateLimiter.js';
import { originGuard } from './middleware/originGuard.js';
import { sharedSecretGuard } from './middleware/sharedSecret.js';
import { noStore, requestId, securityHeaders } from './middleware/securityHeaders.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { turnstileEnabled } from './middleware/turnstile.js';

// Fail fast on an insecure or nonsensical configuration, before binding a port.
validateConfig();

const app = express();

// Don't advertise the stack to anyone fingerprinting the service.
app.disable('x-powered-by');
app.set('etag', false);

/**
 * Render terminates TLS at its own edge proxy, so req.ip and req.secure are only
 * correct once Express knows how many proxies to trust.
 *
 * A hop COUNT, never `true`: with `true` Express takes the leftmost
 * X-Forwarded-For entry, which is entirely client-supplied, and every rate limit
 * below could be bypassed by sending a different fake IP on each request.
 */
app.set('trust proxy', config.trustProxyHops);

app.use(requestId);
app.use(securityHeaders);

/**
 * CORS only instructs the *browser*; it never blocks anything server-side. Every
 * origin here is also enforced by originGuard on /api, which is what actually
 * rejects direct calls from curl, Postman, or another server.
 *
 * In production an empty allowlist means `false` (no origin allowed) rather than
 * '*', so a forgotten env var fails closed. Development reflects the caller's
 * origin so localhost works without configuration.
 */
const corsOptions: CorsOptions = {
  origin: config.corsOrigins.length > 0 ? config.corsOrigins : !config.isProduction,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token', 'X-API-Key'],
  // Lets the frontend read rate-limit state and quote a request id in bug reports.
  exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  // No cookies or HTTP auth are used; keep credentialed cross-origin requests off.
  credentials: false,
  maxAge: 600,
};

app.use(cors(corsOptions));

// Health Check Endpoint (Unthrottled)
// Deliberately outside the /api guards: Render's health probe sends no Origin.
// Reveals nothing about version, environment, or upstream configuration.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * API surface. Order matters:
 *  1. noStore            — chat content must not be cached by any intermediary
 *  2. express.json       — bounded body; oversized payloads die before parsing
 *  3. sharedSecretGuard  — optional; marks a proxy caller as trusted
 *  4. originGuard        — rejects browsers and scripts from other origins
 *  5. apiRateLimiter     — per-IP ceiling across the whole API
 *  6. chatRouter         — per-route limits, session gate, payload validation
 */
app.use(
  '/api',
  noStore,
  express.json({ limit: config.limits.jsonBodyLimit, strict: true }),
  sharedSecretGuard,
  originGuard,
  apiRateLimiter,
  chatRouter
);

app.use(notFoundHandler);
app.use(errorHandler);

// Start server
const server = app.listen(config.port, () => {
  console.log(`🚀 Chatbot backend running on http://localhost:${config.port}`);
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
      `Turnstile: ${turnstileEnabled() ? 'required' : 'off'} | ` +
      `trust proxy hops: ${config.trustProxyHops}`
  );
});

/**
 * Slowloris guard: caps how long a client may take to send a full request.
 * Independent of response duration, so SSE streams are unaffected.
 */
server.requestTimeout = 30_000;

/**
 * Keep-alive must outlive the upstream proxy's idle timeout, otherwise Render
 * reuses a connection Node has just closed and the visitor sees a 502.
 * headersTimeout must stay above keepAliveTimeout.
 */
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

/**
 * Render sends SIGTERM on deploy and on scale-down. Draining in-flight requests
 * beats cutting active SSE streams mid-sentence.
 */
function shutdown(signal: string): void {
  console.log(`${signal} received — draining connections.`);

  const forceExit = setTimeout(() => {
    console.error('Shutdown timed out after 10s; exiting anyway.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close((err) => {
    if (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
    console.log('Closed cleanly.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Log instead of dying silently; the error handler covers per-request failures.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
