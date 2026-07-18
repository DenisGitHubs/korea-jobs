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

describe('scrubContacts — phones/contacts must still be redacted', () => {
  const cut: Array<[string, string]> = [
    ['010-3293-0811', R],
    ['연락처 +82 10 1234 5678', `연락처 ${R}`],
    ['тел 01012345678', R],
    ['02-123-4567', R],
    ['kakao worker2025', `kakao ${R}`],
    ['пишите @job_kr', `пишите ${R}`],
  ];
  for (const [input, expected] of cut) {
    it(`cuts: ${input}`, () => {
      expect(scrubContacts(input)).toBe(expected);
    });
  }
});
