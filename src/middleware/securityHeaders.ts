import type { Context, Next } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Env } from '../types/hono.js';

export async function requestId(c: Context<Env>, next: Next): Promise<void> {
  const reqId = randomUUID();
  c.set('requestId', reqId);

  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0].trim() || '127.0.0.1';
  c.set('clientIp', ip);

  c.header('X-Request-Id', reqId);
  await next();
}

export async function securityHeaders(c: Context<Env>, next: Next): Promise<void> {
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Permitted-Cross-Domain-Policies', 'none');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Origin-Agent-Cluster', '?1');
  c.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');

  await next();
}

export async function noStore(c: Context<Env>, next: Next): Promise<void> {
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
  await next();
}
