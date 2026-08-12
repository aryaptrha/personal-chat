import type { Context, Next } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../config/env.js';
import type { Env } from '../types/hono.js';

function secretsMatch(provided: string, expected: string): boolean {
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

export async function sharedSecretGuard(c: Context<Env>, next: Next): Promise<Response | void> {
  if (!config.apiSharedSecret) {
    await next();
    return;
  }

  const header = c.req.header('x-api-key');
  const reqId = c.get('requestId');
  const ip = c.get('clientIp');

  if (!header || !secretsMatch(header, config.apiSharedSecret)) {
    console.warn(
      `[${reqId}] Rejected /api request with missing or invalid X-API-Key (ip=${ip})`
    );
    return c.json(
      {
        success: false,
        error: 'Unauthorized',
        requestId: reqId,
      },
      401
    );
  }

  c.set('trustedCaller', true);
  await next();
}
