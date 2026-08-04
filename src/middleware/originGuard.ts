import { Request, Response, NextFunction } from 'express';
import { config } from '../config/env.js';

/**
 * Resolves the calling origin, falling back to the Referer's origin for the
 * occasional client that omits `Origin` on same-site requests.
 */
function resolveOrigin(req: Request): string | null {
  const origin = req.get('origin');
  if (origin) {
    try {
      return new URL(origin).origin;
    } catch {
      return null;
    }
  }

  const referer = req.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Rejects requests whose origin is not allowlisted.
 *
 * This is the piece the `cors` package does NOT do. That middleware only
 * decides whether to *add* an `Access-Control-Allow-Origin` header and then
 * calls next() either way — enforcement happens in the browser, which is why a
 * direct Postman or curl call still reaches the handler and still bills the LLM.
 *
 * An attacker can of course send `-H "Origin: https://yoursite"`, so this is a
 * cost barrier rather than authentication. Real authentication for a public
 * frontend is the shared-secret proxy or Turnstile path.
 */
export function originGuard(req: Request, res: Response, next: NextFunction): void {
  // A caller holding the shared secret is a server-side proxy with no Origin.
  if (req.trustedCaller) {
    next();
    return;
  }

  // Preflight is already answered by the cors middleware; never 403 an OPTIONS.
  if (req.method === 'OPTIONS') {
    next();
    return;
  }

  // Startup refuses to boot production with an empty allowlist, so this branch
  // only spares local development the need to configure anything.
  if (config.corsOrigins.length === 0) {
    next();
    return;
  }

  const origin = resolveOrigin(req);

  if (!origin || !config.corsOrigins.includes(origin)) {
    console.warn(
      `[${req.requestId}] Blocked ${req.method} ${req.originalUrl} ` +
        `from origin=${origin ?? 'none'} ip=${req.ip}`
    );
    res.status(403).json({
      success: false,
      error: 'Forbidden: origin not allowed.',
      requestId: req.requestId,
    });
    return;
  }

  next();
}
