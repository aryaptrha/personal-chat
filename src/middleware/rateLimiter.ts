import rateLimit from 'express-rate-limit';
import { config } from '../config/env.js';

/**
 * Express Rate Limiting Middleware
 * Protects API routes from spam, brute-force, and quota exhaustion.
 */
export const apiRateLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax,
  standardHeaders: true, // Return rate limit info in standard RateLimit-* headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
  },
});
