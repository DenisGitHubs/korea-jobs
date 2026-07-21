// lib/korea/digest/run.test.ts
//
// Pure, DB-free coverage of the digest gate + wording. seoulHour must land the send window on the
// Korean morning regardless of the runner's own TZ (CI is UTC), inDigestWindow must be the exact
// [09:00, 12:00) half-open interval, and the line must stay grammatical Russian for any N (owner:
// plain human text, no "1 новых вакансий").
//
// MULTI-GEO: the digest's geo predicate + the has_filters flag live in SQL (kj_geo_match /
// `cardinality(s.region_slugs)>0` / `or s.no_city is false`), so they are exercised by the DB, not here.
// What IS pure and testable is the WORDING contract that has_filters drives: once a region filter (or
// no_city=false) flips has_filters true, the line must read "по твоим фильтрам" (not "в приложении").
// The digestText cases below pin exactly that.

import { describe, it, expect } from 'vitest';
import { seoulHour, inDigestWindow, digestText, ruPluralVac, DIGEST_WINDOW_START_HOUR, DIGEST_WINDOW_END_HOUR } from './run.js';

/** A UTC instant at the given wall-clock UTC hour:minute (Seoul = UTC+9, no DST). */
const utc = (h: number, m = 0): Date => new Date(Date.UTC(2026, 6, 20, h, m, 0));

describe('seoulHour — Asia/Seoul is UTC+9 year-round', () => {
  it('maps 00:00 UTC to 09:00 Seoul', () => {
    expect(seoulHour(utc(0))).toBe(9);
  });
  it('maps 02:30 UTC to 11:xx Seoul', () => {
    expect(seoulHour(utc(2, 30))).toBe(11);
  });
  it('wraps past midnight: 16:00 UTC -> 01:00 Seoul next day', () => {
    expect(seoulHour(utc(16))).toBe(1);
  });
  it('stays inside 0..23 for every UTC hour', () => {
    for (let h = 0; h < 24; h++) {
      const v = seoulHour(utc(h));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(23);
    }
  });
});

describe('inDigestWindow — half-open [09:00, 12:00) Seoul', () => {
  it('opens at the start hour, closes before the end hour', () => {
    expect(DIGEST_WINDOW_START_HOUR).toBe(9);
    expect(DIGEST_WINDOW_END_HOUR).toBe(12);
    expect(inDigestWindow(9)).toBe(true); // 09:xx — first eligible hour
    expect(inDigestWindow(11)).toBe(true); // 11:xx — last eligible hour
    expect(inDigestWindow(12)).toBe(false); // noon is already outside
    expect(inDigestWindow(8)).toBe(false);
    expect(inDigestWindow(0)).toBe(false);
    expect(inDigestWindow(23)).toBe(false);
  });
  it('is open for the Seoul-morning UTC ticks and shut otherwise', () => {
    expect(inDigestWindow(seoulHour(utc(0)))).toBe(true); // 09:00 Seoul
    expect(inDigestWindow(seoulHour(utc(2, 59)))).toBe(true); // 11:59 Seoul
    expect(inDigestWindow(seoulHour(utc(3)))).toBe(false); // 12:00 Seoul — shut
    expect(inDigestWindow(seoulHour(utc(23)))).toBe(false); // 08:00 Seoul — shut
  });
});

describe('ruPluralVac — Russian noun agreement', () => {
  const cases: Array<[number, string]> = [
    [1, 'новая вакансия'],
    [2, 'новые вакансии'],
    [3, 'новые вакансии'],
    [4, 'новые вакансии'],
    [5, 'новых вакансий'],
    [10, 'новых вакансий'],
    [11, 'новых вакансий'], // teens are always genitive plural
    [12, 'новых вакансий'],
    [14, 'новых вакансий'],
    [21, 'новая вакансия'],
    [22, 'новые вакансии'],
    [25, 'новых вакансий'],
    [101, 'новая вакансия'],
    [111, 'новых вакансий'],
  ];
  for (const [n, form] of cases) {
    it(`${n} -> ${form}`, () => {
      expect(ruPluralVac(n)).toBe(form);
    });
  }
});

describe('digestText — filtered vs empty-filter wording', () => {
  it('names the filter when the user has one', () => {
    expect(digestText(5, true)).toBe('За сутки: 5 новых вакансий по твоим фильтрам');
    expect(digestText(1, true)).toBe('За сутки: 1 новая вакансия по твоим фильтрам');
  });
  it('says "в приложении" when the user has no filters', () => {
    expect(digestText(3, false)).toBe('За сутки: 3 новые вакансии в приложении');
    expect(digestText(21, false)).toBe('За сутки: 21 новая вакансия в приложении');
  });
  it('uses the filtered wording once no_city=false makes has_filters true (multi-city)', () => {
    // A user with NO city/work/visa filters but no_city=false still counts as "has filters" in SQL
    // (or s.no_city is false), so the digest line must use the "по твоим фильтрам" wording.
    expect(digestText(7, true)).toBe('За сутки: 7 новых вакансий по твоим фильтрам');
    expect(digestText(2, true)).toBe('За сутки: 2 новые вакансии по твоим фильтрам');
  });
  it('uses the filtered wording when only a REGION filter is set (regions wave)', () => {
    // A user who picked ONLY a province (region_slugs non-empty, no city) still counts as "has filters"
    // in SQL (cardinality(s.region_slugs) > 0), so the digest line must read "по твоим фильтрам".
    expect(digestText(4, true)).toBe('За сутки: 4 новые вакансии по твоим фильтрам');
    expect(digestText(11, true)).toBe('За сутки: 11 новых вакансий по твоим фильтрам');
  });
});
