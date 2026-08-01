// lib/korea/core/context.ts
//
// The auth boundary for every user-facing endpoint. Verifies the Telegram initData
// (HMAC over the raw string), lazily upserts the user, and returns the trusted user
// row. The user id used for scoping ALWAYS comes from here — never from the request
// body/query (007: this is the only barrier against cross-user leakage on Neon).

import { getSql } from './db.js';
import { verifyInitData } from './auth.js';
import { type ReqLike, tmaInitData } from './http.js';
import { getConfigNumber } from '../config.js';
import { bumpVisitStreakBestEffort } from '../streaks/update.js';
import { seoulDate, normalizeDbDate } from './time.js';
import { normalizeRefCode, normalizeAcqSource } from './start-param.js';

// Re-exported so existing importers (bot webhook `/start`) keep resolving these from
// core/context.js. The parsing itself lives in the shared, pure start-param module.
export {
  normalizeRefCode,
  normalizeAcqSource,
  parseStartParam,
  type StartParam,
} from './start-param.js';

export interface AuthedUser {
  id: string;
  telegramId: string;
  publicId: string;
  lang: string;
  allowsWriteToPm: boolean;
  isBlocked: boolean;
}

export type AuthResult = { ok: true; user: AuthedUser } | { ok: false };

// Referral-code extraction (`normalizeRefCode`) now lives in the shared start-param parser
// (./start-param.js), imported + re-exported above. It still yields a 16-hex public_id or
// null — so the attribution branch below is byte-for-byte unchanged — but additionally
// pulls the inviter code out of a "Поделиться вакансией" combined link (v<vacancy>r<ref>).

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
  //
  // Referral attribution only matters when a code is actually present, so the hot path
  // (no start_param) runs the plain upsert untouched. With a code the branch is structural:
  //   * a fresh INSERT binds the ancestors from the resolved code (VALUES) — first touch;
  //   * the ON CONFLICT (UPDATE) path binds ONLY if the existing row is still EMPTY: no
  //     referrer yet, created inside the bind window, and no activation/contact reveal on
  //     record. That narrow window lets the current base opt into virality without ever
  //     re-attributing / hijacking a mature account.
  // Every condition reads the actual target row (users.*), so the outcome is independent
  // of which path inserted first (the Mini App vs the bot /start) — the attribution race
  // is gone without needing to test xmax.
  //
  // A third, mutually exclusive shape exists since 2026-08-01: an ACQUISITION LABEL
  // (`?startapp=ads_ru1`, the link the owner puts into Telegram Ads). It is written to
  // users.acq_source in the INSERT ONLY — see that branch.
  //
  // The label-less upsert — the hot path, and ALSO the fallback used when the acq_source write
  // below cannot run (see there). Defined once so the two callers can never drift apart.
  const plainUpsert = (): Promise<Record<string, unknown>[]> =>
    sql`
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
        returning id, telegram_id, public_id, lang, allows_write_to_pm, is_blocked, visit_streak_day`;

  // Acquisition label (`?startapp=ads_ru1`, e.g. a Telegram Ads campaign). Disjoint from a
  // referral link by construction, so the two branches below are mutually exclusive — an ad
  // visitor never gets an inviter and never disturbs the referral numbers.
  const refCode = normalizeRefCode(idt.startParam ?? null);
  const acqSource = refCode ? null : normalizeAcqSource(idt.startParam ?? null);
  const rows = refCode
    ? await (async () => {
        const bindWindowHours = await getConfigNumber('referral_bind_window_hours', 72);
        return sql`
          with ref as (
            select id as ref_id, referred_by as l2, ref_l2 as l3
            from users
            where public_id = ${refCode} and telegram_id <> ${idt.telegramId}::bigint
            limit 1
          )
          insert into users (
            telegram_id, username, first_name, last_name, lang, allows_write_to_pm,
            referred_by, ref_l2, ref_l3
          )
          values (
            ${idt.telegramId}::bigint, ${idt.username ?? null}, ${idt.firstName ?? null},
            ${idt.lastName ?? null}, ${idt.languageCode ?? 'ru'}, ${idt.allowsWriteToPm === true},
            (select ref_id from ref), (select l2 from ref), (select l3 from ref)
          )
          on conflict (telegram_id) do update set
            username = excluded.username,
            first_name = excluded.first_name,
            last_name = excluded.last_name,
            last_seen_at = now(),
            allows_write_to_pm = users.allows_write_to_pm or excluded.allows_write_to_pm,
            referred_by = case when (select ref_id from ref) is not null
                and users.referred_by is null
                and users.created_at > now() - make_interval(hours => ${bindWindowHours})
                and not exists (select 1 from referral_activations a where a.user_id = users.id)
                and not exists (select 1 from contact_reveals cr where cr.user_id = users.id)
                and not exists (select 1 from ad_contact_reveals ar where ar.user_id = users.id)
              then (select ref_id from ref) else users.referred_by end,
            ref_l2 = case when (select ref_id from ref) is not null
                and users.referred_by is null
                and users.created_at > now() - make_interval(hours => ${bindWindowHours})
                and not exists (select 1 from referral_activations a where a.user_id = users.id)
                and not exists (select 1 from contact_reveals cr where cr.user_id = users.id)
                and not exists (select 1 from ad_contact_reveals ar where ar.user_id = users.id)
              then (select l2 from ref) else users.ref_l2 end,
            ref_l3 = case when (select ref_id from ref) is not null
                and users.referred_by is null
                and users.created_at > now() - make_interval(hours => ${bindWindowHours})
                and not exists (select 1 from referral_activations a where a.user_id = users.id)
                and not exists (select 1 from contact_reveals cr where cr.user_id = users.id)
                and not exists (select 1 from ad_contact_reveals ar where ar.user_id = users.id)
              then (select l3 from ref) else users.ref_l3 end
          returning id, telegram_id, public_id, lang, allows_write_to_pm, is_blocked, visit_streak_day`;
      })()
    : acqSource
      ? // Same upsert as the plain one PLUS the label — and the label is in the INSERT only.
        // The ON CONFLICT branch deliberately does NOT mention acq_source: a second visit, a
        // different campaign link or any later link must never rewrite where a person came
        // from, and an account that already existed is not an acquisition at all.
        await (async () => {
          try {
            return await sql`
              insert into users (
                telegram_id, username, first_name, last_name, lang, allows_write_to_pm, acq_source
              )
              values (
                ${idt.telegramId}::bigint, ${idt.username ?? null}, ${idt.firstName ?? null},
                ${idt.lastName ?? null}, ${idt.languageCode ?? 'ru'}, ${idt.allowsWriteToPm === true},
                ${acqSource}
              )
              on conflict (telegram_id) do update set
                username = excluded.username,
                first_name = excluded.first_name,
                last_name = excluded.last_name,
                last_seen_at = now(),
                allows_write_to_pm = users.allows_write_to_pm or excluded.allows_write_to_pm
              returning id, telegram_id, public_id, lang, allows_write_to_pm, is_blocked, visit_streak_day`;
          } catch (err) {
            // Deploy-before-migrate window: users.acq_source may not exist yet. Losing a
            // campaign count is annoying; refusing to let a person INTO the app (paid click!)
            // is not acceptable — fall back to the label-less upsert and log it.
            // eslint-disable-next-line no-console
            console.error(
              '[auth] acq_source upsert failed, falling back (column missing?):',
              err instanceof Error ? err.message : String(err),
            );
            return plainUpsert();
          }
        })()
      : await plainUpsert();

  const u = rows[0];
  if (!u) return { ok: false };

  // Daily VISIT streak: any authenticated action counts as "opened the app today". The streak
  // advances at most once per Asia/Seoul day, and the upsert above already RETURNed the last
  // credited day — so short-circuit and only pay the extra DB round-trip when today is not yet
  // counted. Pure optimization: the bump statement's own WHERE guard (`visit_streak_day is
  // distinct from $today`) stays the race-safe source of truth, and normalizeDbDate returns null
  // on any ambiguity — so we may over-call (a cheap 0-row no-op) but never wrongly skip a real
  // advance. Best-effort (its own try/catch) — a streak failure must NEVER break auth.
  if (normalizeDbDate(u.visit_streak_day) !== seoulDate()) {
    await bumpVisitStreakBestEffort(sql, u.id as string);
  }

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
