// lib/korea/admin/stats.ts
//
// Admin /stats aggregates. Collect-only, PII-free: every value is a COUNT, never a row
// of user data. Two lightweight count queries (users; then vacancies + user_ads + raw in
// one scalar-subquery query) — cheap enough to run inline in the webhook and still answer
// 200 fast. renderStats() turns them into plain text (NO parse_mode; Susanin/007 brief —
// sendMessage plain text is valid, 4096-char limit; our line block is far under it).
//
// The "Непроверенные" bucket MIRRORS the /api/raw feed (raw/read.ts) 1:1 — same whitelist
// (pending ∪ skipped+low_confidence with a non-NULL confidence, so cached low_confidence repeats —
// pre-AI skips, confidence NULL — are excluded just like the tab), vacancy_id is null, same freshness
// window driven by config raw_max_age_days (clamped to >= 1), so the number matches what users see.

import { getSql } from '../core/db.js';
import { getConfigNumber } from '../config.js';
import { getAllowedAcqSources, ACQ_ALLOWLIST_ECHO_MAX } from '../core/acq-source.js';

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
  // Reach-the-AI funnel over the last 24h (raw_messages): how many rows the parser FINISHED (M) and how
  // many of those actually reached the model (N = M minus the pre-AI skips: spam_prefilter / too_old /
  // duplicate / verdict-cache replays — all of which leave confidence NULL). Shows how much the free
  // filters + verdict cache save. aiProcessed24h == 0 hides the line.
  aiProcessed24h: number;
  aiReached24h: number;
  // AI-geo learning (geo_suggestions, draft_0021). Top-5 unresolved city/region names + top-5 decoded
  // slang pairs — owner inspection, PII-free. Empty when the table is missing or has no rows.
  unknownCities: { surface: string; n: number }[];
  slang: { surface: string; norm: string; n: number }[];
  // Acquisition labels (users.acq_source, draft_0031): where NEW people came from, taken from a
  // labelled deep link `?startapp=ads_ru1` / `?start=ads_ru1` (Telegram Ads «URL to promote»).
  // `sourcesReady=false` means the column is not there yet (migration not applied) — the whole
  // block is then omitted, which is DIFFERENT from "the column exists and nobody came yet".
  sourcesReady: boolean;
  sources: { source: string; total: number; week: number }[];
  // The APPROVED labels currently in force (config acq_sources_allowed, normalized exactly as the
  // gate normalizes them — core/acq-source.ts). Echoed back so the owner can compare the list with
  // what he pasted into the ad cabinet: a label that is not printed here is not being counted.
  // Empty = nothing is being labelled at all (fail-closed default).
  sourcesAllowed: string[];
  // How many well-formed labels arrived in the last 7 days but were NOT on the list (his typo, a
  // label he forgot to add, or a stranger's experiment). COUNT ONLY — the values themselves are
  // never stored anywhere, so there is nothing to print but the number.
  sourceRejects7d: number;
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
           and (status = 'pending'
                or (status = 'skipped' and reject_reason = 'low_confidence' and confidence is not null))
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

  // (3b) Reach-the-AI funnel (owner rule 2026-07-21): of everything the parser FINISHED in the last 24h
  // (M = processed_at within 24h, any terminal status), how many actually reached the model (N). The pre-AI
  // free filters (spam_prefilter / too_old / duplicate) and verdict-cache REPLAYS all skip a row WITHOUT a
  // model call — and crucially every one of them leaves raw_messages.confidence NULL, because confidence is
  // written ONLY on a row the model actually judged (parser/run.ts reject/low_confidence path). So the "did
  // NOT reach AI" bucket = skipped rows with confidence IS NULL, EXCLUDING the two POST-AI blocks
  // (takedown / admin_hidden — those DID reach the model as a vacancy, then got blocked). N = M − that
  // bucket. BEST-EFFORT: any fault degrades to 0/0 and renderStats simply omits the line. Approximate by
  // design (a reject where the model omitted its confidence would fall into the pre-AI bucket — rare).
  let aiProcessed24h = 0, aiReached24h = 0;
  try {
    const fRows = (await sql`
      select
        count(*) filter (where processed_at > now() - interval '24 hours')::int as processed_24h,
        count(*) filter (
          where processed_at > now() - interval '24 hours'
            and status = 'skipped'
            and confidence is null
            and reject_reason is distinct from 'takedown'
            and reject_reason is distinct from 'admin_hidden'
        )::int as pre_ai_24h
      from raw_messages`) as unknown as Record<string, unknown>[];
    const f = fRows[0] ?? {};
    aiProcessed24h = n(f.processed_24h);
    aiReached24h = Math.max(0, aiProcessed24h - n(f.pre_ai_24h));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stats] AI-reach funnel read failed:', err instanceof Error ? err.message : String(err));
  }

  // (4) AI-geo learning ledger (geo_suggestions, draft_0021). BEST-EFFORT: a later migration, so a
  // deploy-before-apply window (or simply no suggestions yet) degrades to empty lists — never breaks
  // /stats. Two tiny top-5 reads; PII-free (place names + counts only).
  let unknownCities: { surface: string; n: number }[] = [];
  let slang: { surface: string; norm: string; n: number }[] = [];
  try {
    const cityRows = (await sql`
      select surface, n from geo_suggestions where kind = 'city'
      order by n desc, last_seen desc limit 5`) as unknown as Record<string, unknown>[];
    const slangRows = (await sql`
      select surface, norm, n from geo_suggestions where kind = 'slang'
      order by n desc, last_seen desc limit 5`) as unknown as Record<string, unknown>[];
    unknownCities = cityRows.map((r) => ({ surface: String(r.surface ?? ''), n: n(r.n) }));
    slang = slangRows.map((r) => ({ surface: String(r.surface ?? ''), norm: String(r.norm ?? ''), n: n(r.n) }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stats] geo_suggestions read failed (table missing?):', err instanceof Error ? err.message : String(err));
  }

  // (5) Acquisition labels (users.acq_source, draft_0031). BEST-EFFORT for the same reason as the
  // blocks above: the column arrives with a later migration, so a deploy-before-apply window must
  // degrade to "no block" instead of breaking the whole report. PII-free — a campaign label the
  // owner invented plus two counts. Ordered by size, capped at 20 so a mistyped label storm can
  // never blow past the 4096-char message limit.
  let sourcesReady = false;
  let sources: { source: string; total: number; week: number }[] = [];
  try {
    const sRows = (await sql`
      select
        acq_source                                                            as source,
        count(*)::int                                                         as total,
        count(*) filter (where created_at > now() - interval '7 days')::int    as week
      from users
      where acq_source is not null
      group by acq_source
      order by count(*) desc, acq_source
      limit 20`) as unknown as Record<string, unknown>[];
    sourcesReady = true;
    sources = sRows.map((r) => ({ source: String(r.source ?? ''), total: n(r.total), week: n(r.week) }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stats] acq_source read failed (column missing?):', err instanceof Error ? err.message : String(err));
  }

  // (5b) The allow-list actually in force + how many labels missed it this week (draft_0032).
  // Both are DIAGNOSTICS for the owner: the list tells him which labels are being counted at all
  // (a label he mistyped in the ad cabinet is simply absent from it), and the reject count tells
  // him that SOMETHING is arriving with a label nobody approved — which is how a typo announces
  // itself. The rejected strings themselves are not stored and are not shown: only the number.
  // Best-effort like every block above (config read / a table from a later migration).
  let sourcesAllowed: string[] = [];
  let sourceRejects7d = 0;
  try {
    sourcesAllowed = (await getAllowedAcqSources()).slice(0, ACQ_ALLOWLIST_ECHO_MAX);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stats] acq allow-list read failed:', err instanceof Error ? err.message : String(err));
  }
  try {
    const rRows = (await sql`
      select coalesce(sum(n), 0)::int as rejects
        from acq_rejects
       where day >= ((now() at time zone 'Asia/Seoul')::date - 6)`) as unknown as Record<string, unknown>[];
    sourceRejects7d = n(rRows[0]?.rejects);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stats] acq_rejects read failed (table missing?):', err instanceof Error ? err.message : String(err));
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
    aiProcessed24h,
    aiReached24h,
    unknownCities,
    slang,
    sourcesReady,
    sources,
    sourcesAllowed,
    sourceRejects7d,
  };
}

/** «1 человек / 2 человека / 5 человек» — the owner reads this, so it has to read like Russian. */
function people(count: number): string {
  const hundred = Math.abs(count) % 100;
  const ten = hundred % 10;
  if (hundred > 10 && hundred < 20) return 'человек';
  if (ten === 1) return 'человек';
  if (ten >= 2 && ten <= 4) return 'человека';
  return 'человек';
}

/** Plain-text report for the admin. No parse_mode, no personal data — aggregates only. */
export function renderStats(s: Stats): string {
  const lines = [
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
  ];
  // Reach-the-AI funnel (owner rule 2026-07-21): of everything processed in 24h, how much actually cost a
  // model call (the free filters + verdict cache do the rest). Only when we have a processed count to divide.
  if (s.aiProcessed24h > 0) {
    const pct = Math.round((s.aiReached24h / s.aiProcessed24h) * 100);
    lines.push(`За сутки: до ИИ дошло ${s.aiReached24h} из ${s.aiProcessed24h} (${pct}%)`);
  }
  // Where new people came from (the label in the link — Telegram Ads and any other labelled link).
  // Shown even when EMPTY, so «реклама идёт, а людей нет» is distinguishable from «ещё не выкачено»:
  // the block appears only once the column exists (sourcesReady), i.e. once the migration is applied.
  if (s.sourcesReady) {
    if (s.sources.length === 0) {
      lines.push('Из рекламы: пока никто не пришёл по ссылке с меткой');
    } else {
      lines.push('Из рекламы (метка в ссылке):');
      for (const x of s.sources) {
        lines.push(`  ${x.source} — ${x.total} ${people(x.total)} (за неделю ${x.week})`);
      }
      if (s.sources.length > 1) {
        const total = s.sources.reduce((acc, x) => acc + x.total, 0);
        const week = s.sources.reduce((acc, x) => acc + x.week, 0);
        lines.push(`  Всего по меткам: ${total} ${people(total)} (за неделю ${week})`);
      }
    }
    // Which labels are being counted AT ALL. A label that is not in this line is not recorded —
    // that is exactly how a typo in the ad cabinet (or a label he forgot to add to the list)
    // becomes visible. Empty list = the mechanism is off and nothing is being labelled.
    lines.push(
      s.sourcesAllowed.length > 0
        ? `  Считаются метки: ${s.sourcesAllowed.join(', ')}`
        : '  Считаются метки: список пуст — ни одна метка не записывается ' +
          '(нужно заполнить список acq_sources_allowed)',
    );
    // Somebody arrived with a label nobody approved. Number only: the values are third-party
    // input, we neither store nor show them. Hidden while it is zero — a quiet report is good news.
    if (s.sourceRejects7d > 0) {
      lines.push(
        `  Мимо списка за неделю: ${s.sourceRejects7d} ` +
          '(метка была, но её нет в списке — проверь, что вписал в кабинете)',
      );
    }
  }
  // AI-geo learning (only when there is something to show): unresolved city/region names + decoded slang.
  if (s.unknownCities.length > 0) {
    lines.push('Незнакомые города (топ-5): ' + s.unknownCities.map((c) => `${c.surface} — ${c.n}`).join(', '));
  }
  if (s.slang.length > 0) {
    lines.push('Сленг (топ-5): ' + s.slang.map((x) => `${x.surface} → ${x.norm || '?'} — ${x.n}`).join(', '));
  }
  return lines.join('\n');
}
