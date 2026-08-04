/**
 * Cloudflare Worker / Pages Function proxy for the chatbot backend.
 *
 * WHY THIS EXISTS
 * ---------------
 * CORS cannot stop a direct Postman or curl call — it only tells a *browser*
 * whether to hand a response back to page JavaScript. Any non-browser client
 * ignores it. So as long as the browser talks to Render directly, the Render URL
 * is public and anyone can replay requests against it.
 *
 * This Worker closes that hole properly:
 *
 *   Browser  ->  https://yoursite.pages.dev/api/*     (same origin, no CORS at all)
 *   Worker   ->  https://your-app.onrender.com/api/*  + X-API-Key
 *
 * The shared secret lives in a Worker secret, never in the Vue bundle. Set
 * API_SHARED_SECRET on Render to the same value and the backend rejects every
 * request that doesn't come through here — the Render URL stops being a usable
 * endpoint for anyone but this Worker.
 *
 * SETUP
 * -----
 * As a Pages Function: save as `functions/api/[[path]].js` in your Vue repo.
 * As a standalone Worker: deploy it and route `yoursite.com/api/*` to it.
 *
 * Then set these (Pages/Workers dashboard -> Settings -> Variables):
 *   BACKEND_URL        https://your-app.onrender.com   (plain variable)
 *   API_SHARED_SECRET  <same value as on Render>       (ENCRYPTED secret)
 *   ALLOWED_ORIGIN     https://yoursite.pages.dev      (plain variable)
 *
 * Note the Worker sends no Origin header. The backend's sharedSecretGuard marks
 * secret-holding callers as trusted, so its origin check stands down for them by
 * design — the secret is the stronger proof.
 */

/** Request headers worth forwarding upstream. Everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = ['content-type', 'x-session-token'];

/** Response headers worth returning to the browser. */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'x-request-id',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
];

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Single implementation shared by the Worker and Pages Function entry points.
 */
async function handleRequest(request, env) {
  const { BACKEND_URL, API_SHARED_SECRET, ALLOWED_ORIGIN } = env;

  if (!BACKEND_URL || !API_SHARED_SECRET) {
    // Misconfiguration must not silently degrade into an open proxy.
    return json({ success: false, error: 'Proxy is not configured.' }, 500);
  }

  const url = new URL(request.url);

  // Same-origin requests need no CORS, but a browser still preflights anything
  // carrying a custom header. Answer it here rather than upstream.
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': ALLOWED_ORIGIN || url.origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type, X-Session-Token',
        'access-control-max-age': '600',
      },
    });
  }

  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed.' }, 405);
  }

  // Only proxy the API surface; never let this become an open relay.
  if (!url.pathname.startsWith('/api/')) {
    return json({ success: false, error: 'Not found' }, 404);
  }

  // Cheap first filter. The backend enforces its own limits regardless.
  if (ALLOWED_ORIGIN) {
    const origin = request.headers.get('origin');
    if (origin && origin !== ALLOWED_ORIGIN) {
      return json({ success: false, error: 'Forbidden' }, 403);
    }
  }

  const upstreamHeaders = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }

  // The part the browser can never see.
  upstreamHeaders.set('x-api-key', API_SHARED_SECRET);

  // Preserve the real client IP so the backend's per-IP rate limits still work.
  // This adds a proxy hop, so set TRUST_PROXY_HOPS=2 on Render when using this.
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) upstreamHeaders.set('x-forwarded-for', clientIp);

  const target = new URL(url.pathname + url.search, BACKEND_URL);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: upstreamHeaders,
      body: request.method === 'POST' ? request.body : undefined,
      redirect: 'manual',
    });
  } catch {
    // Render free instances cold-start and can briefly refuse connections.
    return json({ success: false, error: 'Upstream unavailable.' }, 502);
  }

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set('cache-control', 'no-store');
  if (ALLOWED_ORIGIN) {
    responseHeaders.set('access-control-allow-origin', ALLOWED_ORIGIN);
  }

  // Passing upstream.body straight through keeps SSE streaming intact — the
  // typing effect still works chunk by chunk, with no buffering here.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

/** Standalone Worker entry point. */
export default {
  fetch: handleRequest,
};

/** Cloudflare Pages Functions entry point. */
export const onRequest = (context) => handleRequest(context.request, context.env);
