import type { Context, Next } from 'hono';
import { config } from '../config/env.js';
import type { Env } from '../types/hono.js';

interface RateLimitOptions {
  windowMs: number;
  limit: number;
  message: string;
  standardHeaders?: boolean;
}

const stores = new Map<string, Map<string, { count: number; resetAt: number }>>();
let lastPrune = Date.now();
const PRUNE_INTERVAL_MS = 60_000;

function pruneExpiredStores(now: number) {
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;

  for (const store of stores.values()) {
    for (const [ip, record] of store.entries()) {
      if (now > record.resetAt) {
        store.delete(ip);
      }
    }
  }
}

function createRateLimiter(name: string, getOptions: () => RateLimitOptions) {
  return async (c: Context<Env>, next: Next): Promise<Response | void> => {
    const opts = getOptions();
    const ip = c.get('clientIp') || '127.0.0.1';
    const now = Date.now();

    pruneExpiredStores(now);

    let store = stores.get(name);
    if (!store) {
      store = new Map();
      stores.set(name, store);
    }

    let record = store.get(ip);

    if (!record || now > record.resetAt) {
      record = { count: 1, resetAt: now + opts.windowMs };
      store.set(ip, record);
    } else {
      record.count++;
    }

    const remaining = Math.max(0, opts.limit - record.count);
    const resetSeconds = Math.ceil((record.resetAt - now) / 1000);

    if (opts.standardHeaders !== false) {
      c.header('RateLimit-Limit', String(opts.limit));
      c.header('RateLimit-Remaining', String(remaining));
      c.header('RateLimit-Reset', String(resetSeconds));
    }

    if (record.count > opts.limit) {
      const reqId = c.get('requestId');
      console.warn(`[${reqId}] Rate limit hit on ${c.req.method} ${c.req.url} ip=${ip}`);
      return c.json(
        { success: false, error: opts.message, requestId: reqId },
        429
      );
    }

    await next();
  };
}

export const apiRateLimiter = createRateLimiter('api', () => ({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.max,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
}));

export const chatRateLimiter = createRateLimiter('chat', () => ({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.chatMax,
  message: 'Too many chat requests from this IP, please slow down.',
  standardHeaders: true,
}));

export const chatBurstLimiter = createRateLimiter('chatBurst', () => ({
  windowMs: config.rateLimit.burstWindowMs,
  limit: config.rateLimit.burstMax,
  message: 'You are sending messages too quickly. Wait a moment and try again.',
  standardHeaders: false,
}));

export const sessionRateLimiter = createRateLimiter('session', () => ({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: 'Too many session requests from this IP, please try again later.',
  standardHeaders: true,
}));
