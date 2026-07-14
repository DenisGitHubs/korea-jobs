// lib/korea/admin/auth.ts
//
// Admin authorization for privileged endpoints. Two accepted proofs, fail-closed:
//   (a) Bearer CRON_SECRET — server-to-server / owner tooling (works even before any
//       admin telegram_id is configured).
//   (b) A valid Mini App initData whose telegram_id is in ADMIN_TELEGRAM_IDS
//       (env, comma-separated). ADMIN_TELEGRAM_IDS is filled by the owner later.
//
// No proof => not admin. The telegram_id is taken ONLY from verified initData
// (never from the body), same barrier as every user endpoint.

import { type ReqLike, bearerToken, constantTimeEquals } from '../core/http.js';
import { authenticate, type AuthedUser } from '../core/context.js';

export type AdminResult =
  | { ok: true; via: 'bearer' }
  | { ok: true; via: 'user'; user: AuthedUser }
  | { ok: false };

/** Parse ADMIN_TELEGRAM_IDS ("111,222") into a Set of trimmed strings. */
export function adminTelegramIds(): Set<string> {
  const raw = process.env.ADMIN_TELEGRAM_IDS ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** True when the given telegram_id is a configured admin. */
export function isAdminTelegramId(telegramId: string | number): boolean {
  return adminTelegramIds().has(String(telegramId));
}

/** True when the Authorization bearer equals CRON_SECRET (constant-time). */
export function isAdminBearer(req: ReqLike): boolean {
  return constantTimeEquals(bearerToken(req), process.env.CRON_SECRET);
}

/** Resolve admin status for a request (bearer OR admin initData user). */
export async function requireAdmin(req: ReqLike): Promise<AdminResult> {
  if (isAdminBearer(req)) return { ok: true, via: 'bearer' };
  const auth = await authenticate(req);
  if (auth.ok && isAdminTelegramId(auth.user.telegramId)) {
    return { ok: true, via: 'user', user: auth.user };
  }
  return { ok: false };
}
