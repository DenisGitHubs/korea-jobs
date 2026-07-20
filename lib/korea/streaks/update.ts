// lib/korea/streaks/update.ts
//
// Daily VISIT / OPEN streaks + one-time 7-day bonuses (owner rule 2026-07-20). The day is the
// Asia/Seoul calendar day (seoulDate) — consistent with the digest window. Two counters live on
// users (draft_0018_streaks.sql); the bonuses live in streak_awards.
//
// ATOMICITY (Neon HTTP has no multi-statement transactions): each advance is ONE statement built
// from two CTEs —
//   * `upd` advances the streak with a WHERE guard `*_streak_day is distinct from $today`, so the
//     day is credited at most once and two concurrent requests for one user cannot double-increment
//     (Postgres READ COMMITTED re-checks the guard against the freshly-updated row -> the loser
//     matches 0 rows);
//   * `award` inserts a streak_awards row ONLY when the new length is a fresh multiple of 7,
//     `on conflict (user_id, kind, award_day) do nothing` (idempotent per Seoul-day — a kind pays
//     at most once per day; an honest rebuilt series that reaches 7 again on a LATER day pays
//     again, per the owner decision 2026-07-21, with no farm advantage since a kind can award at
//     most once per day and only on a multiple of 7). award_day is bound to the same $today param
//     the upd guard uses, so the award and the day-advance always agree on "which day".
// The loyalty balance stays derived: sum(confirmed referral_points_ledger) + sum(streak_awards); no
// cached column on users (a cache drifts — same rationale as draft_0004). So there is NOTHING to
// increment here beyond the award row — the award row IS the balance contribution.
//
// Callers invoke the best-effort wrappers: a streak failure must NEVER break auth or a card read.

import { getSql } from '../core/db.js';
import { getConfigNumber } from '../config.js';
import { seoulDate } from '../core/time.js';

type Sql = ReturnType<typeof getSql>;
export type StreakKind = 'visit' | 'open';

interface StreakCols {
  streak: string; // users column holding the count
  day: string; // users column holding the last-credited Seoul day
  bonusKey: string; // config key for the 7-day bonus amount
  bonusDefault: number; // code default when the key is unset (no seed — see draft_0018)
}

// Column names are internal constants (never request input) — safe to interpolate into the
// statement text; only userId / kind / bonus / today are bound as parameters.
const COLS: Record<StreakKind, StreakCols> = {
  visit: { streak: 'visit_streak', day: 'visit_streak_day', bonusKey: 'streak_visit_bonus', bonusDefault: 20 },
  open: { streak: 'open_streak', day: 'open_streak_day', bonusKey: 'streak_open_bonus', bonusDefault: 30 },
};

export interface StreakBump {
  /** streak length after this call (the current value when the day was already counted). */
  len: number;
  /** points granted by THIS call — 0 unless a fresh multiple of 7 was just crossed. */
  awarded: number;
}

/**
 * Advance the `kind` streak for `userId` and grant the 7-day bonus if a fresh multiple of 7 was
 * just reached. Single atomic statement (see file header). Throws on a real DB error — callers use
 * the best-effort wrappers below.
 */
export async function bumpStreak(sql: Sql, userId: string, kind: StreakKind): Promise<StreakBump> {
  const c = COLS[kind];
  const bonus = await getConfigNumber(c.bonusKey, c.bonusDefault);
  const today = seoulDate();

  const text = `
    with upd as (
      update users u
      set ${c.streak} = case when u.${c.day} = $4::date - 1 then u.${c.streak} + 1 else 1 end,
          ${c.day} = $4::date
      where u.id = $1::uuid and u.${c.day} is distinct from $4::date
      returning u.${c.streak} as new_len
    ),
    award as (
      insert into streak_awards (user_id, kind, amount, streak_len, award_day)
      select $1::uuid, $2::text, $3::int, upd.new_len, $4::date
      from upd
      where upd.new_len % 7 = 0 and $3::int > 0
      on conflict (user_id, kind, award_day) do nothing
      returning amount
    )
    select
      coalesce((select new_len from upd), (select ${c.streak} from users where id = $1::uuid), 0)::int as len,
      coalesce((select amount from award), 0)::int as awarded`;

  const rows = (await sql(text, [userId, kind, bonus, today])) as unknown as { len: number; awarded: number }[];
  const r = rows[0];
  return { len: r?.len ?? 0, awarded: r?.awarded ?? 0 };
}

/** Advance the VISIT streak; swallow + log any failure (must never break auth). */
export async function bumpVisitStreakBestEffort(sql: Sql, userId: string): Promise<void> {
  try {
    await bumpStreak(sql, userId, 'visit');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[streak] visit bump failed (best-effort):', err instanceof Error ? err.message : String(err));
  }
}

/** Advance the OPEN streak; swallow + log any failure (must never break a card read). */
export async function bumpOpenStreakBestEffort(sql: Sql, userId: string): Promise<void> {
  try {
    await bumpStreak(sql, userId, 'open');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[streak] open bump failed (best-effort):', err instanceof Error ? err.message : String(err));
  }
}

export interface StreakSummary {
  visitLen: number;
  openLen: number;
  /** sum of ALL streak_awards.amount for this user — the streak contribution to the balance. */
  bonusTotal: number;
}

/**
 * The caller's current streak lengths + total streak-bonus points, for /api/referral and the
 * balance in /api/me. Best-effort: in a deploy-before-migration window (streak_awards / the streak
 * columns not yet applied) it degrades to zeros so the balance endpoints keep serving rather than
 * 500ing — same philosophy as the ai_usage read (draft_0015).
 */
export async function readStreakSummary(sql: Sql, userId: string): Promise<StreakSummary> {
  try {
    const rows = (await sql`
      select
        coalesce(u.visit_streak, 0)::int as visit_len,
        coalesce(u.open_streak, 0)::int  as open_len,
        (select coalesce(sum(amount), 0)::int from streak_awards a where a.user_id = u.id) as bonus_total
      from users u
      where u.id = ${userId}::uuid`) as unknown as {
      visit_len: number;
      open_len: number;
      bonus_total: number;
    }[];
    const r = rows[0];
    return { visitLen: r?.visit_len ?? 0, openLen: r?.open_len ?? 0, bonusTotal: r?.bonus_total ?? 0 };
  } catch {
    return { visitLen: 0, openLen: 0, bonusTotal: 0 };
  }
}
