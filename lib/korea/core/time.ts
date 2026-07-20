// lib/korea/core/time.ts
//
// Small, DB-free time helpers shared across the backend. The product's "day" is ALWAYS the
// Asia/Seoul calendar day (the audience lives in Korea) — consistent with the digest window
// (lib/korea/digest/run.ts seoulHour). Seoul has no DST, so the offset is a constant +9h.

/**
 * The Asia/Seoul calendar day for `now`, as an ISO 'YYYY-MM-DD' string. Mirrors seoulHour:
 * the primary path is Intl with the tz database; if that is unavailable (stripped ICU data)
 * it falls back to a fixed UTC+9 (Seoul has no DST). The string form compares cleanly against
 * a Postgres `date` and is what the streak statements bind as the "today" parameter.
 */
export function seoulDate(now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    /* Intl/tz data missing -> fixed-offset fallback below */
  }
  const shifted = new Date(now.getTime() + 9 * 3600 * 1000); // UTC+9, no DST
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Normalize a Postgres `date` value (as returned by the Neon HTTP driver) to a plain
 * 'YYYY-MM-DD' string, or null when it can't be pinned to an exact calendar day.
 *
 * The Neon serverless driver (v0.10) requests raw text output and applies the standard pg text
 * type-parsers, so a `date` column (OID 1082) is run through postgres-date: a date-only value
 * comes back as `new Date(year, month-1, day)` at LOCAL midnight — a JS Date, NOT a string. A
 * custom type override (or a different driver) may instead yield the raw 'YYYY-MM-DD' string, so
 * both shapes are accepted.
 *
 * Deliberately conservative: only a value we can resolve to a concrete day returns a string;
 * anything else returns null. The visit-streak short-circuit uses this to SKIP a redundant write,
 * so a wrong "known day" would be worse than a wrong null (a dropped streak advance vs a cheap
 * extra no-op) — never guess.
 */
export function normalizeDbDate(v: unknown): string | null {
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // postgres-date builds a date-only value with the LOCAL Date constructor, so read it back
    // with the LOCAL getters — this recovers the stored calendar day exactly on Vercel's UTC
    // runtime and mirrors the parser regardless of the host TZ.
    const y = v.getFullYear();
    const mo = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  return null;
}

/** True iff `prevDay` ('YYYY-MM-DD') is the calendar day immediately before `today`. */
export function isDayBefore(prevDay: string, today: string): boolean {
  const p = Date.parse(`${prevDay}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(p) || Number.isNaN(t)) return false;
  return t - p === 86_400_000; // exactly one UTC day (dates are tz-agnostic here)
}

export interface StreakTransition {
  /** streak length after this day is applied (unchanged when the day was already counted). */
  len: number;
  /** false when `prevDay === today` (the day is already credited — no advance, no award). */
  advanced: boolean;
  /** the series length that earns a bonus (a fresh multiple of 7), or null when none. */
  awardLen: number | null;
}

/**
 * Pure transition rule for a daily streak — the exact logic the atomic SQL UPDATE in
 * lib/korea/streaks/update.ts encodes, extracted so it can be unit-tested without a DB:
 *   * prevDay === today   -> no change (already counted today), no award;
 *   * prevDay === yesterday -> len + 1 (the series continues);
 *   * otherwise (null / older) -> len resets to 1.
 * A bonus fires when the new length is a full multiple of 7.
 */
export function nextStreak(prevLen: number, prevDay: string | null, today: string): StreakTransition {
  if (prevDay === today) return { len: prevLen, advanced: false, awardLen: null };
  const continues = prevDay !== null && isDayBefore(prevDay, today);
  const len = continues ? prevLen + 1 : 1;
  return { len, advanced: true, awardLen: len % 7 === 0 ? len : null };
}
