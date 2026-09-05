import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors/index.js';
import { HANDOFF_TOKEN_TTL_SECONDS } from './session.js';

/**
 * T2.14 — the token that carries a buyer from a chat into our page.
 *
 * Signed and short-lived, and **consumed on first use**: the URL it lives in survives in a
 * transcript, a browser history and a referrer header long after the buyer has finished, so
 * a token that stayed valid would be a session anyone with the scrollback could resume.
 *
 * Deliberately not a JWT. A JWT here would be longer, would invite someone to put claims in
 * it that then have to stay in sync with the session, and brings a library's worth of
 * algorithm-confusion footguns for a payload that is one identifier and one timestamp.
 */

export interface HandoffToken {
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

export function issueHandoffToken(sessionId: string, secret: string, now = new Date()): HandoffToken {
  const expiresAtSeconds = Math.floor(now.getTime() / 1000) + HANDOFF_TOKEN_TTL_SECONDS;
  // A nonce, so two tokens for the same session at the same second are still distinct and
  // consuming one cannot silently consume the other.
  const nonce = randomBytes(6).toString('base64url');
  const payload = `${sessionId}.${expiresAtSeconds}.${nonce}`;

  return {
    token: `${base64url(payload)}.${sign(payload, secret)}`,
    sessionId,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

export interface VerifiedHandoff {
  readonly sessionId: string;
  /** The whole token, which is what a consumed-token store keys on. */
  readonly token: string;
}

export function verifyHandoffToken(
  token: string,
  secret: string,
  now = new Date(),
): VerifiedHandoff {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) {
    throw new AppError('INVALID_HANDOFF_TOKEN', 'That link is not valid.');
  }

  const payload = Buffer.from(encoded, 'base64url').toString('utf8');
  const expected = sign(payload, secret);

  /**
   * Constant-time, because this is a signature check on a value an attacker supplies and
   * can retry. A byte-by-byte comparison that returns early leaks how much of a forgery was
   * correct, one request at a time.
   */
  const given = Buffer.from(signature, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new AppError('INVALID_HANDOFF_TOKEN', 'That link is not valid.');
  }

  const [sessionId, expiresAtSeconds] = payload.split('.');
  if (!sessionId || !expiresAtSeconds) {
    throw new AppError('INVALID_HANDOFF_TOKEN', 'That link is not valid.');
  }

  if (Number(expiresAtSeconds) * 1000 <= now.getTime()) {
    /**
     * Its own code, because expiry is not an error the buyer caused.
     *
     * The page shows "start again" rather than a failure — someone who left a chat open
     * over lunch should be invited back, not told they did something wrong.
     */
    throw new AppError('HANDOFF_TOKEN_EXPIRED', 'This link has expired. Start again from the chat.');
  }

  return { sessionId, token };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
