// lib/korea/parser/spamfilter.test.ts
//
// The pre-AI spam filter must reject near-certain non-jobs (crypto/OTC exchange blasts, emoji
// carpets) while NEVER touching a real Korea manual-labour ad. The negative set intentionally
// includes the collisions we engineered around: the bare noun "обмен опытом", and legitimate ads
// that use a few emoji bullets. Owner examples (2026-07-19) are pinned verbatim below.

import { describe, it, expect } from 'vitest';
import { looksLikeSpam, looksLikeEmojiCarpet } from './spamfilter.js';

describe('looksLikeSpam — crypto/OTC exchange spam must be caught', () => {
  const spam: string[] = [
    // Owner's flagship example (Exchange Express): OTC-сервис + цифровых активов + USDT/BTC/ETH.
    'Exchange Express — инфраструктурный OTC-сервис обмена цифровых активов 💎 USDT/BTC/ETH, лучший курс',
    // Owner keyword: "крипта" (bare root — the old cyrillic \b pattern missed this).
    'Меняю крипту на воны, быстро и надёжно, пишите в личку',
    // Owner keyword: "Криптоактивы".
    'Криптоактивы и криптовалюта, инвестиции с гарантией дохода',
    // Bare latin tickers as standalone tokens.
    'Куплю BTC и ETH, наличные, встреча в Сеуле',
    'OTC обмен, крупные суммы, комиссия минимальная',
    // "цифровых активов" phrasing on its own.
    'Быстрый обмен цифровых активов, prime exchange, гарантия',
    // private/прайвет-обмен label.
    'Прайвет-обмен крипты по выгодному курсу, только для своих',
    // "обмен" + currency word (the combo, not the bare noun).
    'Обмен валюты выгодно, воны наличными, звоните',
    // "exchange" as a standalone word.
    'Надёжный exchange, работаем 24/7, депозит от 100',
  ];
  for (const s of spam) {
    it(`rejects: ${s.slice(0, 40)}`, () => {
      expect(looksLikeSpam(s)).toBe(true);
    });
  }
});

describe('looksLikeSpam — emoji carpets must be caught', () => {
  const spam: string[] = [
    // Owner example: rows of a single emoji with a couple of words.
    '🎾🎾🎾🎾🎾🎾🎾🎾🎾🎾 жми ссылку',
    '💎💎💎💎💎💎💎💎💎 залетай, деньги ждут',
    '🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥 акция',
  ];
  for (const s of spam) {
    it(`rejects: ${s.slice(0, 20)}`, () => {
      expect(looksLikeSpam(s)).toBe(true);
    });
  }
});

describe('looksLikeSpam — real vacancies must pass', () => {
  const ok: string[] = [
    // Owner example: a real factory ad with one emoji and a hundred letters.
    '🏭 Завод в Ансане, стабильная работа, зарплата 2 800 000 вон в месяц, жильё и питание, виза E-9. Контакт: @hr_ansan',
    // A few emoji bullets + the collision phrase "обмен опытом" (must NOT trip the обмен combo).
    '🏭📦🚚 Склад в Инчхоне, погрузка-разгрузка, обмен опытом с бригадой, зарплата достойная, оформление по визе',
    // Emoji bullets ARE legit when there is real content (> 40 letters/digits).
    '🔧 Ремонт, 🏠 жильё, 💰 хорошая оплата, 📞 звоните, работа в Сеуле стабильная надолго, виза не важна',
    // Plain legit ads (no emoji, no crypto).
    'Требуется рабочий на ферму, сбор урожая, проживание рядом, оплата еженедельно',
    'Стройка в Сеуле, вахта, оплата еженедельно, виза E-9, жильё предоставляется',
    'Уборка в отеле, почасовая ставка 12000 вон, стабильный график, оформление',
  ];
  for (const s of ok) {
    it(`keeps: ${s.slice(0, 40)}`, () => {
      expect(looksLikeSpam(s)).toBe(false);
    });
  }
});

describe('looksLikeEmojiCarpet — threshold justification (emoji >= 8 AND content < 40)', () => {
  it('7 emoji is below the emoji floor → not a carpet', () => {
    expect(looksLikeEmojiCarpet('🎾'.repeat(7) + ' жми')).toBe(false);
  });
  it('8 emoji with < 40 letters → carpet', () => {
    expect(looksLikeEmojiCarpet('🎾'.repeat(8) + ' жми')).toBe(true);
  });
  it('many emoji but >= 40 letters of real content → not a carpet', () => {
    const longAd = 'Завод в Ансане стабильная зарплата жильё питание виза оформление звоните';
    expect(looksLikeEmojiCarpet('🎾'.repeat(12) + ' ' + longAd)).toBe(false);
  });
  it('empty / plain text is never a carpet', () => {
    expect(looksLikeEmojiCarpet('')).toBe(false);
    expect(looksLikeEmojiCarpet('обычная вакансия без эмодзи')).toBe(false);
  });
});

describe('looksLikeSpam — existing (2026-07-18) patterns stay green', () => {
  const spam: string[] = [
    'ЮСДТ обмен, быстро и надёжно',
    'Помогу с деньгами, дам в долг под низкий процент',
    'Набор в Binance, обучение трейдингу с нуля',
    'Работа нужна? Пиши на @recruiter',
    'Instagram obunachi xizmati, накрутка подписчиков недорого',
  ];
  for (const s of spam) {
    it(`rejects: ${s.slice(0, 30)}`, () => {
      expect(looksLikeSpam(s)).toBe(true);
    });
  }
  it('handles null/empty defensively', () => {
    expect(looksLikeSpam(null)).toBe(false);
    expect(looksLikeSpam(undefined)).toBe(false);
    expect(looksLikeSpam('')).toBe(false);
  });
});
