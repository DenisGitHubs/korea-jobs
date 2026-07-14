// lib/korea/core/auth.ts
//
// Telegram Mini App initData verification (server-side only).
//
// Narrow surface: verifyInitData(raw, botToken, ttlSec) -> AuthResult
// (discriminated union, no throw). Call sites only branch on `ok`.
//
// PROTOCOL (Susanin brief, verified by 007 — 2026-07-13, unchanged in Bot API 10.1):
//   initData is the raw query string from Telegram.WebApp.initData.
//   1. secret     = HMAC_SHA256(key="WebAppData", msg=botToken)
//   2. data_check = every "key=value" EXCEPT `hash`, sorted by key, joined with "\n"
//                   (`signature` STAYS in — only the SEPARATE Ed25519 method drops it)
//   3. expected   = HMAC_SHA256(key=secret, msg=data_check), hex
//   4. compare expected vs provided hash with timingSafeEqual ONLY
//   5. reject if now - auth_date > ttlSec
//
// telegram_id is extracted as an EXACT DECIMAL STRING from the raw `user` value
// BEFORE JSON.parse — a Telegram id can exceed 2^53 and JSON.parse would silently
// round it (nhatrang extractUserIdRaw pattern; Roma/007 both flagged this).

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Identity extracted from a verified initData payload. */
export interface AuthIdentity {
  /** Telegram user id as an exact decimal string (bigint-safe; matches users.telegram_id). */
  telegramId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
  /**
   * `allows_write_to_pm` (Bot API 6.9+): client HINT that the bot may DM this user.
   *   true  -> may PM; false -> may not; null -> field absent ("unknown", NOT false).
   * Kept distinct from false so a legacy payload that omits it is never read as "revoked".
   * The stored flag is only ever RAISED, never lowered from this hint.
   */
  allowsWriteToPm: boolean | null;
  /** Deep-link start_param, when present. */
  startParam?: string;
}

export type AuthFailReason =
  | 'missing_initdata'
  | 'malformed'
  | 'bad_hash'
  | 'expired';

export type AuthResult =
  | { ok: true; identity: AuthIdentity }
  | { ok: false; reason: AuthFailReason };

const DEFAULT_TTL_SEC = 900; // 15 min — replay guard (Telegram gives no number; 5–60 min band).

/**
 * Verify a raw Telegram Mini App initData string. Pure and self-contained:
 * no I/O, no env reads, no throw on invalid input (only a programming-error
 * guard on an empty botToken). Never logs the payload.
 */
export function verifyInitData(
  raw: string,
  botToken: string,
  ttlSec: number = DEFAULT_TTL_SEC,
): AuthResult {
  if (!botToken) {
    throw new Error('verifyInitData: botToken is required');
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'missing_initdata' };
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const providedHash = params.get('hash');
  if (!providedHash || !/^[0-9a-f]{64}$/i.test(providedHash)) {
    return { ok: false, reason: 'malformed' };
  }

  // data_check_string: EVERY received pair EXCEPT `hash`, sorted by key, joined by "\n".
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  if (!timingSafeEqualHex(expectedHash, providedHash)) {
    return { ok: false, reason: 'bad_hash' };
  }

  const authDateRaw = params.get('auth_date');
  const authDate = authDateRaw ? Number(authDateRaw) : NaN;
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, reason: 'malformed' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - authDate > ttlSec) {
    return { ok: false, reason: 'expired' };
  }

  const userRaw = params.get('user');
  if (!userRaw) {
    return { ok: false, reason: 'malformed' };
  }

  // Extract the id as an EXACT decimal string from the raw JSON before parsing,
  // so a value > 2^53 is not rounded. Requires a plain integer id.
  const idMatch = /"id"\s*:\s*(\d+)/.exec(userRaw);
  if (!idMatch) {
    return { ok: false, reason: 'malformed' };
  }
  const telegramId = idMatch[1]!; // the single capture group matched -> present

  let username: string | undefined;
  let firstName: string | undefined;
  let lastName: string | undefined;
  let languageCode: string | undefined;
  let allowsWriteToPm: boolean | null = null;
  try {
    const user = JSON.parse(userRaw) as {
      username?: unknown;
      first_name?: unknown;
      last_name?: unknown;
      language_code?: unknown;
      allows_write_to_pm?: unknown;
    };
    if (typeof user.username === 'string') username = user.username;
    if (typeof user.first_name === 'string') firstName = user.first_name;
    if (typeof user.last_name === 'string') lastName = user.last_name;
    if (typeof user.language_code === 'string') languageCode = user.language_code;
    if (typeof user.allows_write_to_pm === 'boolean') allowsWriteToPm = user.allows_write_to_pm;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const startParam = params.get('start_param') ?? undefined;
  return {
    ok: true,
    identity: {
      telegramId,
      allowsWriteToPm,
      ...(username ? { username } : {}),
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      ...(languageCode ? { languageCode } : {}),
      ...(startParam ? { startParam } : {}),
    },
  };
}

/** Constant-time comparison of two equal-length hex strings (case-normalized). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a.toLowerCase(), 'utf8');
  const bufB = Buffer.from(b.toLowerCase(), 'utf8');
  return timingSafeEqual(bufA, bufB);
}
