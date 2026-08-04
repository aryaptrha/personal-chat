import { Request, Response, NextFunction } from 'express';
import { config } from '../config/env.js';
import { verifySessionToken } from '../services/sessionToken.js';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Whether the Turnstile gate is switched on. */
export const turnstileEnabled = (): boolean => Boolean(config.turnstileSecretKey);

interface SiteVerifyResponse {
  success?: boolean;
  'error-codes'?: string[];
}

/**
 * Verifies a Turnstile response token with Cloudflare.
 *
 * Turnstile is the one control here that meaningfully separates "a human in a
 * browser on your site" from "a script", without making visitors log in. Since
 * the frontend already runs on Cloudflare Pages, it costs nothing to enable.
 */
export async function verifyTurnstileToken(
  token: string,
  ip: string | undefined
): Promise<{ ok: boolean; errorCodes: string[] }> {
  const body = new URLSearchParams({ secret: config.turnstileSecretKey, response: token });
  if (ip) body.set('remoteip', ip);

  // Never let a slow or unreachable Cloudflare hang the request forever.
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

/**
 * Requires a valid session token on /api/chat once Turnstile is enabled.
 * A no-op when TURNSTILE_SECRET_KEY is unset, so existing deployments and local
 * development are unaffected until it is configured.
 */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!turnstileEnabled() || req.trustedCaller) {
    next();
    return;
  }

  const token = req.get('x-session-token');
  const verdict = verifySessionToken(token, req.ip);

  if (!verdict.valid) {
    console.warn(`[${req.requestId}] Rejected chat: session token ${verdict.reason} (ip=${req.ip})`);
    res.status(401).json({
      success: false,
      error: 'Invalid or expired session. Request a new one from /api/session.',
      code: 'SESSION_INVALID',
      requestId: req.requestId,
    });
    return;
  }

  next();
}
