import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { config } from '../config/env.js';

/**
 * Express Rate Limiting Middleware
 * Protects API routes from spam, brute-force, and quota exhaustion.
 *
 * These limits are keyed on the client IP, which is only correct because
 * `app.set('trust proxy', <hops>)` is configured in index.ts. Without it every
 * visitor behind Render's edge proxy shares a single bucket and the limits
 * effectively vanish.
 *
 * The default key generator is used deliberately rather than a custom `req.ip`
 * one: it already groups IPv6 addresses by subnet, which stops a client holding
 * a /64 allocation from getting a fresh bucket for every request.
 */

function jsonLimitHandler(message: string) {
  return (req: Request, res: Response): void => {
    console.warn(`[${req.requestId}] Rate limit hit on ${req.method} ${req.originalUrl} ip=${req.ip}`);
    res.status(429).json({ success: false, error: message, requestId: req.requestId });
  };
}

/** Broad ceiling across every /api route. */
export const apiRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.max,
  standardHeaders: true, // Return rate limit info in standard RateLimit-* headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  handler: jsonLimitHandler('Too many requests from this IP, please try again later.'),
});

/**
 * Tighter ceiling for the only endpoint that spends money. Layered on top of
 * apiRateLimiter rather than replacing it.
 */
export const chatRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.chatMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler('Too many chat requests from this IP, please slow down.'),
});

/**
 * Short-window burst guard. The main window alone would let a client empty its
 * entire quota in one second and cause a spike in LLM spend.
 */
export const chatBurstLimiter = rateLimit({
  windowMs: config.rateLimit.burstWindowMs,
  limit: config.rateLimit.burstMax,
  standardHeaders: false,
  legacyHeaders: false,
  handler: jsonLimitHandler('You are sending messages too quickly. Wait a moment and try again.'),
});

/** Keeps Turnstile verification from being abused as a free proxy to Cloudflare. */
export const sessionRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler('Too many session requests from this IP, please try again later.'),
});
