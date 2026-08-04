import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Tags every request with a correlation id. Errors return this id instead of a
 * stack trace, so a user can quote it and the real cause stays in the logs.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

/**
 * Baseline hardening headers for a JSON-only API.
 *
 * Written by hand rather than pulling in Helmet: this service serves no HTML,
 * so only a handful of headers apply and they are cheaper to audit here than as
 * an extra dependency in the supply chain.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  // Nothing here is ever a document, so lock scripting and embedding down hard.
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Origin-Agent-Cluster', '?1');

  // Only advertise HSTS on connections that actually arrived over TLS, which
  // requires `trust proxy` to be set so req.secure reflects X-Forwarded-Proto.
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }

  next();
}

/**
 * Chat traffic is personal and per-user. Cloudflare sits in front of the
 * frontend and other intermediaries may sit anywhere, so mark API responses
 * as never cacheable rather than trusting every hop to guess correctly.
 */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}
