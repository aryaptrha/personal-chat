import { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../config/env.js';

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * Both sides are hashed first so the buffers are always 32 bytes:
 * `timingSafeEqual` throws on length mismatch, and that throw would itself
 * reveal the expected secret's length.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

/**
 * Optional shared-secret gate for /api.
 *
 * Disabled unless `API_SHARED_SECRET` is set. It is meant for a server-side
 * caller — the Cloudflare Worker proxy in `examples/` — which can hold a secret
 * the browser never sees. Embedding this key in the Vue bundle would achieve
 * nothing, since anyone can read it from the Network tab.
 */
export function sharedSecretGuard(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiSharedSecret) {
    next();
    return;
  }

  const header = req.get('x-api-key');

  if (!header || !secretsMatch(header, config.apiSharedSecret)) {
    console.warn(
      `[${req.requestId}] Rejected /api request with missing or invalid X-API-Key (ip=${req.ip})`
    );
    res.status(401).json({
      success: false,
      error: 'Unauthorized',
      requestId: req.requestId,
    });
    return;
  }

  // Proven server-side caller: it legitimately has no browser Origin header.
  req.trustedCaller = true;
  next();
}
