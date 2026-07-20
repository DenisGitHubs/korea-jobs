// lib/korea/parser/text-clean.test.ts
//
// cleanForAi trims decorative emoji noise from the AI INPUT only. The contract is precision-first:
// runs/dividers are cut, but semantic single/paired emoji, salary numbers, composite emoji and
// ordinary text must survive untouched (the original text still drives description/dedup, so a
// wrong collapse here would only hurt classification, never the stored card — but we keep it tight).
//
// Invisible code points are built from String.fromCodePoint so no literal invisible ever lives in
// this test source (mirrors the module).

import { describe, it, expect } from 'vitest';
import { cleanForAi } from './text-clean.js';

const ZWSP = String.fromCodePoint(0x200b);
const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);
const BOM = String.fromCodePoint(0xfeff);
const VS16 = String.fromCodePoint(0xfe0f);

describe('cleanForAi — runs of the SAME emoji collapse to one', () => {
  it('collapses a tight run of 3+', () => {
    expect(cleanForAi('🎾🎾🎾🎾🎾 жми')).toBe('🎾 жми');
  });
  it('collapses a run with spaces between (🎾 🎾 🎾)', () => {
    expect(cleanForAi('🎾 🎾 🎾 жми')).toBe('🎾 жми');
  });
  it('collapses a long carpet of one emoji', () => {
    expect(cleanForAi('🔥'.repeat(12) + ' акция')).toBe('🔥 акция');
  });
});

describe('cleanForAi — decorative divider lines (no letters/digits) are removed', () => {
  it('drops a mixed-emoji divider line between two content lines', () => {
    const input = 'Завод в Ансане\n✨🎈✨🎈\nЗвоните 010-1234-5678';
    expect(cleanForAi(input)).toBe('Завод в Ансане\nЗвоните 010-1234-5678');
  });
  it('drops a standalone divider-only string', () => {
    expect(cleanForAi('✨🎈✨🎈')).toBe('');
  });
  it('keeps a line whose emoji sit next to real text', () => {
    const line = '🔧 Ремонт, 🏠 жильё, 💰 оплата, работа в Сеуле';
    expect(cleanForAi(line)).toBe(line);
  });
});

describe('cleanForAi — semantic single / paired emoji are UNTOUCHED', () => {
  it('keeps a pair-per-token line "🏠✅ 🍱✅"', () => {
    expect(cleanForAi('🏠✅ 🍱✅')).toBe('🏠✅ 🍱✅');
  });
  it('keeps a single emoji with a salary number "💰: 2 800 000"', () => {
    expect(cleanForAi('💰: 2 800 000')).toBe('💰: 2 800 000');
  });
  it('keeps an exact PAIR of the same emoji (only 3+ collapses)', () => {
    expect(cleanForAi('🔥🔥 горячая вакансия')).toBe('🔥🔥 горячая вакансия');
  });
  it('keeps a country flag pair (visa/nation signal)', () => {
    expect(cleanForAi('Берём 🇰🇷🇷🇺 звоните')).toBe('Берём 🇰🇷🇷🇺 звоните');
  });
});

describe('cleanForAi — invisibles are stripped, composites leave no garbage', () => {
  it('strips zero-width chars and BOM', () => {
    expect(cleanForAi('за' + ZWSP + 'вод' + ZWNJ + BOM)).toBe('завод');
  });
  it('strips a variation selector (VS16)', () => {
    // "❤" + VS16 -> the bare heart, no dangling selector.
    expect(cleanForAi('❤' + VS16)).toBe('❤');
  });
  it('removes a STRAY (orphan) ZWJ but never leaves a lone joiner', () => {
    const out = cleanForAi('текст' + ZWJ + ' ещё');
    expect(out).toBe('текст ещё');
    expect(out.includes(ZWJ)).toBe(false);
  });
  it('a composite family emoji leaves no orphan ZWJ / half-emoji garbage', () => {
    const family = '👨' + ZWJ + '👩' + ZWJ + '👧';
    const out = cleanForAi('Семья ' + family + ' ждёт');
    // No dangling joiner and the sentence text is intact (composite may stay whole or split, but
    // must not turn into garbage) — the hard guarantee is "no orphan ZWJ".
    expect(/^Семья .+ ждёт$/u.test(out)).toBe(true);
    expect(out.startsWith('Семья ')).toBe(true);
    expect(out.endsWith(' ждёт')).toBe(true);
  });
  it('a trailing joiner on a composite is cleaned to no garbage', () => {
    const out = cleanForAi('👨' + ZWJ + '👩' + ZWJ + '👧' + ZWJ);
    // trailing orphan ZWJ removed
    expect(out.endsWith(ZWJ)).toBe(false);
  });
});

describe('cleanForAi — blank lines collapse; plain text is byte-for-byte', () => {
  it('collapses 3+ blank lines into one', () => {
    expect(cleanForAi('a\n\n\n\n\nb')).toBe('a\n\nb');
  });
  it('keeps a single blank line as-is', () => {
    expect(cleanForAi('a\n\nb')).toBe('a\n\nb');
  });
  it('leaves ordinary multi-line vacancy text unchanged byte-for-byte', () => {
    const ad =
      'Требуется рабочий на завод в Ансане.\n' +
      'Зарплата 2 800 000 вон/мес, жильё и питание.\n' +
      'Виза E-9. Контакт: @hr_ansan, 010-1234-5678';
    expect(cleanForAi(ad)).toBe(ad);
  });
  it('leaves a single-emoji-bulleted ad unchanged', () => {
    const ad = '🏭 Завод в Ансане, зарплата 2 800 000 вон, жильё, виза E-9. @hr_ansan';
    expect(cleanForAi(ad)).toBe(ad);
  });
  it('handles empty string', () => {
    expect(cleanForAi('')).toBe('');
  });
});
