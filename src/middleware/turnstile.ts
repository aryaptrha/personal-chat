import type { Context, Next } from 'hono';
import { config } from '../config/env.js';
import { verifySessionToken } from '../services/sessionToken.js';
import type { Env } from '../types/hono.js';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const turnstileEnabled = (): boolean => Boolean(config.turnstileSecretKey);

interface SiteVerifyResponse {
  success?: boolean;
  'error-codes'?: string[];
}

export async function verifyTurnstileToken(
  token: string,
  ip: string | undefined
): Promise<{ ok: boolean; errorCodes: string[] }> {
  const body = new URLSearchParams({ secret: config.turnstileSecretKey, response: token });
  if (ip) body.set('remoteip', ip);

  const abort = AbortSignal.timeout(10_000);

  const response = await fetch(SITEVERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: abort,
  });

  if (!response.ok) {
    return { ok: false, errorCodes: [`siteverify-http-${response.status}`] };
  }

  const result = (await response.json()) as SiteVerifyResponse;
  return { ok: result.success === true, errorCodes: result['error-codes'] ?? [] };
}

export async function requireSession(c: Context<Env>, next: Next): Promise<Response | void> {
  if (!turnstileEnabled() || c.get('trustedCaller')) {
    await next();
    return;
  }

  const token = c.req.header('x-session-token');
  const ip = c.get('clientIp');
  const verdict = verifySessionToken(token, ip);

  if (!verdict.valid) {
    const reqId = c.get('requestId');
    console.warn(`[${reqId}] Rejected chat: session token ${verdict.reason} (ip=${ip})`);
    return c.json(
      {
        success: false,
        error: 'Invalid or expired session. Request a new one from /api/session.',
        code: 'SESSION_INVALID',
        requestId: reqId,
      },
      401
    );
  }

  await next();
}
