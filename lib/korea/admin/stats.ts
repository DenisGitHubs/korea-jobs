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
  // AI token accounting (ai_usage ledger). 24h detail + a rolling $ estimate for 24h / 30d.
  aiCalls24h: number;
  aiInput24h: number;
  aiOutput24h: number;
  aiCacheRead24h: number;
  /** Calls in 24h that had to (re)write the cache — cache_creation_tokens>0 ("остывания"). */
  aiColds24h: number;
  aiCost24h: number;
  aiCost30d: number;
}

/** Coerce a driver count (int4 -> number, but guard string/NULL) to a safe integer. */
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * Approximate USD cost of a token bundle at claude-haiku-4-5 rates (per 1e6 tokens):
 *   input $1 · output $5 · cache-read $0.10 · cache-write $2 (1h ttl ≈ 2x base; the SDK's 5m
 *   default would be 1.25x). input_tokens excludes cached tokens, so the four terms don't
 *   double-count. Bump these constants if the model/tariff changes.
 */
function aiCostUsd(input: number, output: number, cacheRead: number, cacheWrite: number): number {
  return (input * 1 + output * 5 + cacheRead * 0.1 + cacheWrite * 2) / 1_000_000;
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

  // (3) AI usage/cost from the ai_usage ledger. BEST-EFFORT: ai_usage is a later migration
  // (draft_0015) — if it is not applied yet (deploy-before-migrate window) the read throws and we
  // degrade to zeros so /stats never breaks. bigint sums arrive as strings; n() coerces them.
  let aiCalls24h = 0, aiInput24h = 0, aiOutput24h = 0, aiCacheRead24h = 0, aiColds24h = 0;
  let aiCost24h = 0, aiCost30d = 0;
  try {
    const aRows = (await sql`
      select
        count(*) filter (where called_at > now() - interval '24 hours')::int                        as calls_24h,
        count(*) filter (where called_at > now() - interval '24 hours' and cache_creation_tokens > 0)::int as colds_24h,
        coalesce(sum(input_tokens)          filter (where called_at > now() - interval '24 hours'), 0)::bigint as in_24h,
        coalesce(sum(output_tokens)         filter (where called_at > now() - interval '24 hours'), 0)::bigint as out_24h,
        coalesce(sum(cache_read_tokens)     filter (where called_at > now() - interval '24 hours'), 0)::bigint as cread_24h,
        coalesce(sum(cache_creation_tokens) filter (where called_at > now() - interval '24 hours'), 0)::bigint as cwrite_24h,
        coalesce(sum(input_tokens)          filter (where called_at > now() - interval '30 days'), 0)::bigint  as in_30d,
        coalesce(sum(output_tokens)         filter (where called_at > now() - interval '30 days'), 0)::bigint  as out_30d,
        coalesce(sum(cache_read_tokens)     filter (where called_at > now() - interval '30 days'), 0)::bigint  as cread_30d,
        coalesce(sum(cache_creation_tokens) filter (where called_at > now() - interval '30 days'), 0)::bigint  as cwrite_30d
      from ai_usage`) as unknown as Record<string, unknown>[];
    const a = aRows[0] ?? {};
    aiCalls24h = n(a.calls_24h);
    aiColds24h = n(a.colds_24h);
    aiInput24h = n(a.in_24h);
    aiOutput24h = n(a.out_24h);
    aiCacheRead24h = n(a.cread_24h);
    aiCost24h = aiCostUsd(n(a.in_24h), n(a.out_24h), n(a.cread_24h), n(a.cwrite_24h));
    aiCost30d = aiCostUsd(n(a.in_30d), n(a.out_30d), n(a.cread_30d), n(a.cwrite_30d));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stats] ai_usage read failed (table missing?):', err instanceof Error ? err.message : String(err));
  }

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
    aiCalls24h,
    aiInput24h,
    aiOutput24h,
    aiCacheRead24h,
    aiColds24h,
    aiCost24h,
    aiCost30d,
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
    `ИИ за 24ч: вызовов ${s.aiCalls24h} · вход ${s.aiInput24h} · выход ${s.aiOutput24h} · ` +
      `кэш-чтение ${s.aiCacheRead24h} · остываний ${s.aiColds24h} · ≈$${s.aiCost24h.toFixed(2)}`,
    `ИИ за 30 дней: ≈$${s.aiCost30d.toFixed(2)}`,
  ].join('\n');
}
