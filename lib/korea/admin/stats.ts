// lib/korea/admin/stats.ts
//
// Admin /stats aggregates. Collect-only, PII-free: every value is a COUNT, never a row
// of user data. Two lightweight count queries (users; then vacancies + user_ads + raw in
// one scalar-subquery query) — cheap enough to run inline in the webhook and still answer
// 200 fast. renderStats() turns them into plain text (NO parse_mode; Susanin/007 brief —
// sendMessage plain text is valid, 4096-char limit; our line block is far under it).
//
// The "Непроверенные" bucket MIRRORS the /api/raw feed (raw/read.ts) 1:1 — same whitelist
// (pending ∪ skipped+low_confidence), vacancy_id is null, same freshness window driven by
// config raw_max_age_days (clamped to >= 1), so the number matches what users actually see.

import { getSql } from '../core/db.js';
import { getConfigNumber } from '../config.js';

export interface Stats {
  usersTotal: number;
  usersNew24h: number;
  usersNew7d: number;
  usersActive24h: number;
  usersActive7d: number;
  usersPmOk: number;
  usersBlocked: number;
  usersReferred: number;
  vacancies: number;
  adsApproved: number;
  adsPending: number;
  unverified: number;
  /** Freshness window (days) applied to the "Непроверенные" bucket; echoed in the text. */
  unverifiedMaxAgeDays: number;
}

/** Coerce a driver count (int4 -> number, but guard string/NULL) to a safe integer. */
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * Gather all aggregates. Two count queries; no personal data leaves the DB.
 * Throws on a DB fault — the caller (webhook) turns that into a short admin message.
 */
export async function gatherStats(): Promise<Stats> {
  const sql = getSql();

  // Mirror raw/read.ts: clamp to >= 1 so a mis-seeded 0/negative config can't blank or
  // break the window (make_interval).
  const maxAge = Math.max(1, Math.floor(await getConfigNumber('raw_max_age_days', 14)));

  // (1) users — one row of filtered counts (all cast ::int so the driver yields numbers).
  const uRows = (await sql`
    select
      count(*)::int                                                           as total,
      count(*) filter (where created_at   > now() - interval '24 hours')::int as new_24h,
      count(*) filter (where created_at   > now() - interval '7 days')::int   as new_7d,
      count(*) filter (where last_seen_at > now() - interval '24 hours')::int as active_24h,
      count(*) filter (where last_seen_at > now() - interval '7 days')::int   as active_7d,
      count(*) filter (where allows_write_to_pm)::int                         as pm_ok,
      count(*) filter (where is_blocked)::int                                 as blocked,
      count(*) filter (where referred_by is not null)::int                    as referred
    from users`) as unknown as Record<string, unknown>[];
  const u = uRows[0] ?? {};

  // (2) content counts — vacancies + user_ads(approved/pending) + raw(unverified) in one
  // query via scalar subqueries. The raw subquery is byte-mirrored from raw/read.ts.
  const cRows = (await sql`
    select
      (select count(*) from vacancies where is_active and duplicate_of is null)::int as vacancies,
      (select count(*) from user_ads where status = 'approved'
         and (expires_at is null or expires_at > now()))::int                        as ads_approved,
      (select count(*) from user_ads where status = 'pending')::int                  as ads_pending,
      (select count(*) from raw_messages
         where vacancy_id is null
           and (status = 'pending' or (status = 'skipped' and reject_reason = 'low_confidence'))
           and fetched_at > now() - make_interval(days => ${maxAge}))::int           as unverified
  `) as unknown as Record<string, unknown>[];
  const c = cRows[0] ?? {};

  return {
    usersTotal: n(u.total),
    usersNew24h: n(u.new_24h),
    usersNew7d: n(u.new_7d),
    usersActive24h: n(u.active_24h),
    usersActive7d: n(u.active_7d),
    usersPmOk: n(u.pm_ok),
    usersBlocked: n(u.blocked),
    usersReferred: n(u.referred),
    vacancies: n(c.vacancies),
    adsApproved: n(c.ads_approved),
    adsPending: n(c.ads_pending),
    unverified: n(c.unverified),
    unverifiedMaxAgeDays: maxAge,
  };
}

/** Plain-text report for the admin. No parse_mode, no personal data — aggregates only. */
export function renderStats(s: Stats): string {
  return [
    'Статистика',
    `Пользователи: всего ${s.usersTotal} · новых за 24ч ${s.usersNew24h} / за 7д ${s.usersNew7d} · ` +
      `активных за 24ч ${s.usersActive24h} / за 7д ${s.usersActive7d}`,
    `Пуши разрешили: ${s.usersPmOk} · заблокировали бота: ${s.usersBlocked} · ` +
      `пришли по рефералке: ${s.usersReferred}`,
    `Вакансии в ленте: ${s.vacancies} (активные, без дублей)`,
    `Объявления людей: одобрено ${s.adsApproved} · на модерации ${s.adsPending}`,
    `Непроверенные: ${s.unverified} (pending ≤${s.unverifiedMaxAgeDays} дней)`,
  ].join('\n');
}
