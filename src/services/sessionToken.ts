import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config/env.js';

/**
 * Stateless, signed session tokens.
 *
 * Turnstile tokens are single-use and expire in minutes, so verifying one per
 * chat message would force the user through a challenge on every turn. Instead
 * Turnstile is verified once at POST /api/session, which hands back one of these
 * tokens for the rest of the conversation.
 *
 * Stateless on purpose: Render free instances restart and scale to zero, so
 * anything held in process memory would be lost. The signature makes server-side
 * storage unnecessary.
 */

let cachedSecret: string | null = null;

/**
 * Resolved on first use rather than at import time, so a deployment with
 * Turnstile switched off never sees a warning about a key it doesn't need.
 */
function getSecret(): string {
  if (cachedSecret) return cachedSecret;

  if (config.sessionTokenSecret) {
    cachedSecret = config.sessionTokenSecret;
  } else {
    cachedSecret = randomBytes(32).toString('hex');
    console.warn(
      '⚠️  SESSION_TOKEN_SECRET is not set; using a random per-boot key. ' +
        'Existing session tokens will be rejected after every restart or deploy.'
    );
  }

  return cachedSecret;
}

function sign(payload: string): string {
  return createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

/**
 * Binds the token to a coarse client fingerprint so a leaked token is not
 * freely transferable. The IP is hashed rather than embedded, keeping the token
 * free of personal data.
 */
function fingerprint(ip: string | undefined): string {
  return createHmac('sha256', getSecret()).update(ip || 'unknown').digest('base64url').slice(0, 16);
}

export function issueSessionToken(ip: string | undefined): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + config.sessionTtlMs;
  const payload = `${expiresAt}.${fingerprint(ip)}`;
  return { token: `${payload}.${sign(payload)}`, expiresAt };
}

export type SessionVerdict =
  | { valid: true }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'ip_mismatch' };

export function verifySessionToken(token: string | undefined, ip: string | undefined): SessionVerdict {
  if (!token) return { valid: false, reason: 'malformed' };

  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };

  const [expiresAtRaw, tokenFingerprint, signature] = parts;
  const payload = `${expiresAtRaw}.${tokenFingerprint}`;

  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { valid: false, reason: 'bad_signature' };
  }

  // Signature verified, so the values below are ours and safe to trust.
  const expiresAt = Number.parseInt(expiresAtRaw, 10);
  if (Number.isNaN(expiresAt) || Date.now() > expiresAt) {
    return { valid: false, reason: 'expired' };
  }

  if (tokenFingerprint !== fingerprint(ip)) {
    return { valid: false, reason: 'ip_mismatch' };
  }

  return { valid: true };
}
