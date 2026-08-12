import type { Context, Next } from 'hono';
import { config } from '../config/env.js';
import type { Env } from '../types/hono.js';

function resolveOrigin(c: Context<Env>): string | null {
  const origin = c.req.header('origin');
  if (origin) {
    try {
      return new URL(origin).origin;
    } catch {
      return null;
    }
  }

  const referer = c.req.header('referer');
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }

  return null;
}

export async function originGuard(c: Context<Env>, next: Next): Promise<Response | void> {
  if (c.get('trustedCaller')) {
    await next();
    return;
  }

  if (c.req.method === 'OPTIONS') {
    await next();
    return;
  }

  if (config.corsOrigins.length === 0) {
    await next();
    return;
  }

  const origin = resolveOrigin(c);
  const reqId = c.get('requestId');
  const ip = c.get('clientIp');

  if (!origin || !config.corsOrigins.includes(origin)) {
    console.warn(
      `[${reqId}] Blocked ${c.req.method} ${c.req.url} from origin=${origin ?? 'none'} ip=${ip}`
    );
    return c.json(
      {
        success: false,
        error: 'Forbidden: origin not allowed.',
        requestId: reqId,
      },
      403
    );
  }

  await next();
}
