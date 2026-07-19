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
import { getSql } from '../core/db.js';

type Sql = ReturnType<typeof getSql>;

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

/** True when the given telegram_id is a configured admin (env only, no DB). */
export function isAdminTelegramId(telegramId: string | number): boolean {
  return adminTelegramIds().has(String(telegramId));
}

/**
 * True when telegramId is an admin. Env list first (works with no DB, cheap, sync),
 * else ONE SELECT for a users row with role='admin'. FAIL-CLOSED: any SELECT error
 * yields false — a DB hiccup must never grant admin. Owner rule: recognise admins by
 * DB role so the owner need not touch the Vercel panel to add ADMIN_TELEGRAM_IDS.
 */
export async function isAdminTelegram(sql: Sql, telegramId: string | number): Promise<boolean> {
  if (isAdminTelegramId(telegramId)) return true;
  try {
    const rows = (await sql`
      select exists(
        select 1 from users
        where telegram_id = ${String(telegramId)}::bigint and role = 'admin'
      ) as ok`) as unknown as { ok: boolean }[];
    return rows[0]?.ok === true;
  } catch {
    // Fail-closed: never grant admin on a role-lookup error.
    return false;
  }
}

/**
 * All admin DM recipients: env ADMIN_TELEGRAM_IDS ∪ telegram_id of every users row with
 * role='admin'. Deduped, returned as strings (Telegram chat ids). Best-effort: a DB error
 * degrades to the env ids only and never throws (callers run this on notify paths that
 * must not fail an already-committed write). ONE SELECT, no per-recipient query.
 */
export async function adminRecipients(sql: Sql): Promise<string[]> {
  const ids = new Set<string>(adminTelegramIds());
  try {
    const rows = (await sql`
      select telegram_id::text as tid from users where role = 'admin'`) as unknown as {
      tid: string | null;
    }[];
    for (const r of rows) {
      if (r.tid) ids.add(r.tid);
    }
  } catch {
    // Best-effort: fall back to env ids only (no PII, no payload logged).
    // eslint-disable-next-line no-console
    console.error('[admin] recipients db lookup failed');
  }
  return [...ids];
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
