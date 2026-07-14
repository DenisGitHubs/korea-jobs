// lib/korea/core/context.ts
//
// The auth boundary for every user-facing endpoint. Verifies the Telegram initData
// (HMAC over the raw string), lazily upserts the user, and returns the trusted user
// row. The user id used for scoping ALWAYS comes from here — never from the request
// body/query (007: this is the only barrier against cross-user leakage on Neon).

import { getSql } from './db.js';
import { verifyInitData } from './auth.js';
import { type ReqLike, tmaInitData } from './http.js';

export interface AuthedUser {
  id: string;
  telegramId: string;
  publicId: string;
  lang: string;
  allowsWriteToPm: boolean;
  isBlocked: boolean;
}

export type AuthResult = { ok: true; user: AuthedUser } | { ok: false };

/** Verify `Authorization: tma <initData>` and upsert the user. Fail-closed. */
export async function authenticate(req: ReqLike): Promise<AuthResult> {
  const raw = tmaInitData(req);
  if (!raw) return { ok: false };

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) throw new Error('auth: BOT_TOKEN is not set');
  const ttl = Number(process.env.INITDATA_TTL_SECONDS ?? '900') || 900;

  const v = verifyInitData(raw, botToken, ttl);
  if (!v.ok) return { ok: false };
  const idt = v.identity;

  const sql = getSql();
  // Upsert: refresh profile + last_seen; allows_write_to_pm is only ever RAISED
  // (a stale payload that omits it must never lower a granted flag). lang is set on
  // first insert only — the app owns the display language after that.
  const rows = await sql`
    insert into users (telegram_id, username, first_name, last_name, lang, allows_write_to_pm)
    values (
      ${idt.telegramId}::bigint, ${idt.username ?? null}, ${idt.firstName ?? null},
      ${idt.lastName ?? null}, ${idt.languageCode ?? 'ru'}, ${idt.allowsWriteToPm === true}
    )
    on conflict (telegram_id) do update set
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      last_seen_at = now(),
      allows_write_to_pm = users.allows_write_to_pm or excluded.allows_write_to_pm
    returning id, telegram_id, public_id, lang, allows_write_to_pm, is_blocked`;

  const u = rows[0];
  if (!u) return { ok: false };
  return {
    ok: true,
    user: {
      id: u.id as string,
      telegramId: String(u.telegram_id),
      publicId: u.public_id as string,
      lang: u.lang as string,
      allowsWriteToPm: u.allows_write_to_pm === true,
      isBlocked: u.is_blocked === true,
    },
  };
}
