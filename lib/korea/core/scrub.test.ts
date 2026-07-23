// lib/korea/core/scrub.test.ts
//
// Regression suite for the contact scrubber, focused on the money-vs-phone boundary in rule #7.
// The bug (2026-07-18): the generic long-digit-run rule redacted big salary amounts as if they
// were phones, so "В месяц 2 500 000~3 000 000 вон" became "В месяц [скрыто]~[скрыто]".
//
// SECURITY invariant: rule #7 may only ADD "keep" for money; it must never let a phone through.
// The phone cases below (and the labelled/handle/link cases) must all still redact.

import { describe, it, expect } from 'vitest';
import { scrubContacts } from './scrub.js';

const R = '[скрыто]';

describe('scrubContacts — money amounts must survive', () => {
  const keep: Array<[string, string]> = [
    ['월 2 500 000원', '월 2 500 000원'],
    ['시급 12000원', '시급 12000원'],
    ['300만원', '300만원'],
    ['В месяц 2 500 000~3 000 000 вон', 'В месяц 2 500 000~3 000 000 вон'],
    ['зарплата 2500000 вон', 'зарплата 2500000 вон'],
    ['연봉 30 000 000원 협의', '연봉 30 000 000원 협의'],
    ['оплата 2 500 000 - 3 000 000 руб', 'оплата 2 500 000 - 3 000 000 руб'],
  ];
  for (const [input, expected] of keep) {
    it(`keeps: ${input}`, () => {
      expect(scrubContacts(input)).toBe(expected);
    });
  }
});

// 2026-07-23 bug: RE_GENERIC_PHONE began its match on the minutes of a clock time ("00" after
// "21:"), ran through the amount "120.000 -3.3", and — because those digits start with 0 — judged
// the whole thing phone-shaped and redacted it. Result: "15:00-21:[скрыто]%" (minutes + salary
// eaten). Fix = time guard (don't start on time minutes) + percent rescue (a run before "%" is a
// rate, never a phone). The trailing phone line must STILL be redacted.
describe('scrubContacts — clock times and percent/tax figures must survive', () => {
  const keep: Array<[string, string]> = [
    ['15:00-21:00', '15:00-21:00'], // time interval stays whole
    ['15:00-21:00 120.000 -3.3%', '15:00-21:00 120.000 -3.3%'], // time + amount + percent
    ['120.000 -3.3%', '120.000 -3.3%'], // amount followed by percent (tax) — rescued
    ['9:00~18:00', '9:00~18:00'], // single-digit hour, tilde range
    ['수수료 12.000.000 -3.3%', '수수료 12.000.000 -3.3%'], // long amount before percent
  ];
  for (const [input, expected] of keep) {
    it(`keeps: ${input}`, () => {
      expect(scrubContacts(input)).toBe(expected);
    });
  }

  it('confirmed case: keeps the time+salary line, still redacts the phone below it', () => {
    const raw = '15:00-21:00 120.000 -3.3%\n010-0000-0000 Татьяна';
    expect(scrubContacts(raw)).toBe(`15:00-21:00 120.000 -3.3%\n${R} Татьяна`);
  });
});

describe('scrubContacts — phones/contacts must still be redacted', () => {
  const cut: Array<[string, string]> = [
    ['010-1111-2222', R],
    ['010-0000-0000 Татьяна', `${R} Татьяна`], // the confirmed-case phone, standalone
    ['연락처 +82 10 1234 5678', `연락처 ${R}`],
    ['тел 01012345678', R],
    ['тел: 123456', R], // labelled short number still cut
    ['02-123-4567', R],
    ['시간 9:00 01012345678', `시간 9:00 ${R}`], // phone AFTER a time: time kept, phone cut
    ['kakao worker2025', `kakao ${R}`],
    ['пишите @job_kr', `пишите ${R}`],
  ];
  for (const [input, expected] of cut) {
    it(`cuts: ${input}`, () => {
      expect(scrubContacts(input)).toBe(expected);
    });
  }
});

// 2026-07-23 review (Цензор major + 007 minor): the old defenses had two holes at the
// time/percent boundary. (a) The time guard `(?<!\d:\d?)` shielded 2 positions after ANY
// "digit:", so a phone glued to a FAKE clock ("9:01012345678") started on its 3rd digit — a
// partial contact leak. (b) The percent rescue kept ANY run before '%' with no leading '+'/0,
// so an international phone typed without either ("821012345678%") survived. Fix = mask only REAL
// HH:MM before the phone pass, and refuse the percent rescue for phone-length runs.
describe('scrubContacts — review edge cases (time/percent boundary)', () => {
  it('an incomplete time does NOT shield a glued phone: "9:01012345678"', () => {
    const out = scrubContacts('9:01012345678');
    expect(out).toBe(`9:${R}`); // the 11-digit phone is gone, not just its tail
    expect(out).not.toMatch(/\d{9,}/); // no long digit run survives anywhere
  });

  it('a phone-length run before "%" is NOT rescued: "821012345678%"', () => {
    // +82 mobile typed without '+' and without a leading 0 — not phone-shaped, so only the
    // tightened percent rescue stands between it and a leak. It must be redacted.
    expect(scrubContacts('821012345678%')).toBe(`${R}%`);
  });

  it('a grouped amount before "%" IS still rescued: "12.000.000 -3.3%"', () => {
    expect(scrubContacts('12.000.000 -3.3%')).toBe('12.000.000 -3.3%');
  });
});
