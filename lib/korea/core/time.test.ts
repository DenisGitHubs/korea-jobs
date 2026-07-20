// lib/korea/core/time.test.ts
//
// Pure, DB-free coverage of the Seoul-day helper and the streak transition rule. seoulDate must
// land the correct Asia/Seoul calendar day regardless of the runner's own TZ (CI is UTC), and
// nextStreak must encode exactly the same logic as the atomic SQL in streaks/update.ts:
//   same day -> no change; yesterday -> +1; a gap/first -> reset to 1; a fresh multiple of 7 awards.

import { describe, it, expect } from 'vitest';
import { seoulDate, isDayBefore, nextStreak, normalizeDbDate } from './time.js';

/** A UTC instant at the given wall-clock UTC hour (Seoul = UTC+9, no DST). */
const utc = (y: number, mo: number, d: number, h = 0, mi = 0): Date =>
  new Date(Date.UTC(y, mo - 1, d, h, mi, 0));

describe('seoulDate — Asia/Seoul is UTC+9 year-round', () => {
  it('keeps the same calendar day for a Seoul-daytime instant', () => {
    // 03:00 UTC = 12:00 Seoul, same date.
    expect(seoulDate(utc(2026, 7, 20, 3))).toBe('2026-07-20');
  });
  it('rolls to the next day once past 15:00 UTC (00:00 Seoul)', () => {
    // 15:00 UTC = 00:00 Seoul next day.
    expect(seoulDate(utc(2026, 7, 20, 15))).toBe('2026-07-21');
    // 14:59 UTC = 23:59 Seoul, still the same day.
    expect(seoulDate(utc(2026, 7, 20, 14, 59))).toBe('2026-07-20');
  });
  it('handles a month/year boundary in Seoul', () => {
    // 2026-12-31 16:00 UTC = 2027-01-01 01:00 Seoul.
    expect(seoulDate(utc(2026, 12, 31, 16))).toBe('2027-01-01');
  });
  it('always returns a well-formed YYYY-MM-DD', () => {
    for (let h = 0; h < 24; h++) {
      expect(seoulDate(utc(2026, 7, 20, h))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('isDayBefore', () => {
  it('is true only for the immediately preceding calendar day', () => {
    expect(isDayBefore('2026-07-19', '2026-07-20')).toBe(true);
    expect(isDayBefore('2026-07-18', '2026-07-20')).toBe(false); // two days
    expect(isDayBefore('2026-07-20', '2026-07-20')).toBe(false); // same day
    expect(isDayBefore('2026-07-21', '2026-07-20')).toBe(false); // future
  });
  it('spans a month boundary', () => {
    expect(isDayBefore('2026-06-30', '2026-07-01')).toBe(true);
  });
  it('is false for garbage input rather than throwing', () => {
    expect(isDayBefore('not-a-date', '2026-07-20')).toBe(false);
  });
});

describe('nextStreak — transition rule mirrored by the atomic SQL', () => {
  it('does nothing when the day is already counted (idempotent same-day)', () => {
    expect(nextStreak(3, '2026-07-20', '2026-07-20')).toEqual({ len: 3, advanced: false, awardLen: null });
  });
  it('continues (+1) when the previous day was yesterday', () => {
    expect(nextStreak(3, '2026-07-19', '2026-07-20')).toEqual({ len: 4, advanced: true, awardLen: null });
  });
  it('resets to 1 after a gap', () => {
    expect(nextStreak(9, '2026-07-15', '2026-07-20')).toEqual({ len: 1, advanced: true, awardLen: null });
  });
  it('resets to 1 on the very first day (prevDay null)', () => {
    expect(nextStreak(0, null, '2026-07-20')).toEqual({ len: 1, advanced: true, awardLen: null });
  });
  it('awards on a fresh multiple of 7', () => {
    expect(nextStreak(6, '2026-07-19', '2026-07-20')).toEqual({ len: 7, advanced: true, awardLen: 7 });
    expect(nextStreak(13, '2026-07-19', '2026-07-20')).toEqual({ len: 14, advanced: true, awardLen: 14 });
  });
  it('does not award when a 7-multiple is only re-touched on the same day', () => {
    // Already at 7 today -> revisiting the same day must not re-award.
    expect(nextStreak(7, '2026-07-20', '2026-07-20')).toEqual({ len: 7, advanced: false, awardLen: null });
  });
  it('a rebuilt streak walks 1..7 again over contiguous days and awards again at 7', () => {
    // Contiguous 7-day walk; the first step follows a long gap so it resets to 1. The award fires
    // again at 7 — under the award_day idempotency (unique(user_id,kind,award_day)) the DB PAYS it,
    // since that day-7 lands on a different Seoul-day than any earlier series (owner decision
    // 2026-07-21: "каждые 7 дней" applies to a rebuilt series too).
    const days = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'];
    let len = 0;
    let day = '2026-07-01'; // far in the past -> first step resets to 1
    const seq: number[] = [];
    const awards: (number | null)[] = [];
    for (const d of days) {
      const t = nextStreak(len, day, d);
      len = t.len;
      day = d;
      seq.push(t.len);
      awards.push(t.awardLen);
    }
    expect(seq).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(awards).toEqual([null, null, null, null, null, null, 7]);
  });
});

describe('normalizeDbDate — the Neon driver may hand back a Date OR a raw string', () => {
  it('returns the day from a raw YYYY-MM-DD string', () => {
    expect(normalizeDbDate('2026-07-20')).toBe('2026-07-20');
  });
  it('trims a timestamp-ish string down to its date part', () => {
    expect(normalizeDbDate('2026-07-20T00:00:00.000Z')).toBe('2026-07-20');
    expect(normalizeDbDate('2026-07-20 15:30:00')).toBe('2026-07-20');
  });
  it('reads a LOCAL-midnight Date the way postgres-date builds a date column', () => {
    // The driver parses a date-only value to new Date(y, m-1, d) at local midnight; building the
    // same way here keeps the assertion TZ-independent (month arg is 0-based).
    expect(normalizeDbDate(new Date(2026, 6, 20))).toBe('2026-07-20');
    expect(normalizeDbDate(new Date(2027, 0, 1))).toBe('2027-01-01');
  });
  it('zero-pads single-digit month/day', () => {
    expect(normalizeDbDate(new Date(2026, 2, 5))).toBe('2026-03-05');
  });
  it('returns null for null / undefined / non-date input (caller then falls through to the DB)', () => {
    expect(normalizeDbDate(null)).toBeNull();
    expect(normalizeDbDate(undefined)).toBeNull();
    expect(normalizeDbDate(123)).toBeNull();
    expect(normalizeDbDate('garbage')).toBeNull();
    expect(normalizeDbDate(new Date('nonsense'))).toBeNull(); // Invalid Date
  });
});
