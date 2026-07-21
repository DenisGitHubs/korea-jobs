// lib/korea/parser/spamfilter.test.ts
//
// The pre-AI spam filter must reject near-certain non-jobs (crypto/OTC exchange blasts, emoji
// carpets) while NEVER touching a real Korea manual-labour ad. The negative set intentionally
// includes the collisions we engineered around: the bare noun "обмен опытом", and legitimate ads
// that use a few emoji bullets. Owner examples (2026-07-19) are pinned verbatim below.

import { describe, it, expect } from 'vitest';
import { looksLikeSpam, looksLikeEmojiCarpet, looksLikePharma } from './spamfilter.js';

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

// Data-driven set validated 2026-07-21 against the 287-msg reject corpus with 0 FP on 521 confirmed
// real vacancies. Positives are one representative per group; negatives are REAL vacancy phrasings
// (incl. the exact collisions we tightened around) that MUST keep passing.
describe('looksLikeSpam — extended (2026-07-21) reject-corpus patterns must be caught', () => {
  const spam: Array<[string, string]> = [
    ['g1 tema',      'Есть тема как поднять денег быстро, пиши в лс'],
    ['g1 podnyat',   'Помогу поднять денег без вложений, летсгоу'],
    ['g1 vyvodim',   'Выводим 50к в день, всё чисто, обучение с нуля'],
    ['g1 odnodelo',  'Ищу людей в одно дело, доход от 200к'],
    ['g1 minors',    'Халтура для подростков, 10000 сразу на карту'],
    ['g3 kotikov',   'Нужен человек на доставку котиков, оплата в тот же день'],
    ['g3 scheta',    'Приму счета в аренду, хороший процент'],
    ['g4 keta',      'Оформим K-ETA быстро и недорого, полный пакет'],
    ['g4 podkluch',  'Виза G1 под ключ, полный пакет документов, оплата после готовности'],
    // Direct order (под ключ → visa word) must also fire — proximity is symmetric.
    ['g4 podkluch2', 'Оформление под ключ: виза G1, полный пакет документов'],
    ['g4 diplomy',   'Разные дипломы и водительские удостоверения, любой регион'],
    ['g5 tether',    'Продаю Tether сеть TRC20, лучший курс'],
    ['g6 casino',    'Регистрируйся, бонус сразу на баланс, укажите промокод WIN'],
    ['g8 profil',    'Mening profilimga kir, faqat kattalar uchun'],
    ['g8 prostit',   'Проститутки Сеула, выезд, дёшево'],
    ['g9 spamga',    'Akkountingiz spamga tushgan? Yechib beramiz'],
    ['g10 folder',   'Добавьте папку с каналами и получите доступ'],
    ['g11 udalyon',  'Работа на удалёнке, доход от 100к в неделю'],
    ['g11 gorodaru', 'Набор сотрудников в городах России, обучение бесплатно'],
    ['g12 shill',    'Взял займ, скинули сразу на карту, всем советую'],
    ['g13 babki',    'Срочно нужны бабки? Пиши, помогу за час'],
    ['g13 taxi',     'Такси по Корее недорого, любой город, звоните'],
  ];
  for (const [label, s] of spam) {
    it(`rejects [${label}]: ${s.slice(0, 34)}`, () => {
      expect(looksLikeSpam(s)).toBe(true);
    });
  }

  // Zero-width injection (bots splice ZWSP/ZWNJ inside words) must still be caught after the strip.
  it('catches g8 spam obfuscated with zero-width chars inside the word', () => {
    const zwProfilim = 'p​r‌o‍f​i‌l‍i​mga kir'; // -> "profilimga"
    expect(looksLikeSpam(zwProfilim)).toBe(true);
  });

  // 💊 pill carpet (pharma) is spam; a lone decorative 💊 is not.
  it('catches a 💊-carpet pharma blast (>= 2 pills)', () => {
    expect(looksLikePharma('💊 Аптека без рецепта 💊 доставка по всей Корее 💊')).toBe(true);
    expect(looksLikeSpam('💊 Аптека без рецепта 💊 доставка по всей Корее 💊')).toBe(true);
  });
  it('does NOT treat a single 💊 as pharma spam', () => {
    expect(looksLikePharma('💊 Требуется фасовщик витаминов на склад, зарплата 2.7 млн вон, виза')).toBe(false);
  });
});

describe('looksLikeSpam — real vacancies from the corpus MUST pass (tightened-rule negatives)', () => {
  const ok: string[] = [
    // "под ключ" WITHOUT migration context is a construction ad — must pass (g4 tightening).
    'Ремонт квартир под ключ, нужны отделочники, оплата сдельно, жильё рядом',
    'Строим дома под ключ, требуется бригада каменщиков, вахта, питание',
    // g4 PROXIMITY: "ремонт под ключ" and "виза" in DIFFERENT sentences must pass — the old
    // two-lookahead form false-dropped this. 0-FP gate on an irreversible filter (owner).
    'Ремонт под ключ, нужны отделочники. Виза E-9 обязательна, оформление поможем',
    // …and the same two words split across a bullet line (no period) — a construction ad's usual
    // formatting; the \n boundary in the window keeps it out.
    '🔧 Ремонт квартир под ключ, бригада\nВиза F4 приветствуется, жильё рядом',
    // g4 LEFT BOUNDARY (Censor, gate 21.07): "виз" as a mid-word stem (суперВИЗор) plus
    // "под ключ" in the same sentence must NOT fire — the window may not cut into a word.
    'Ищем супервизора на производство, работаем под ключ, оплата достойная',
    'Супервизор смены нужен срочно, цех работает под ключ с клиентами',
    // "жильё предоставляется" / "сдаётся ванрум" inside a real ad — must pass (g14 was dropped).
    'Завод в Ансане, автомобилка с жильём предоставляется, 1 мужчина, виза F',
    'Требуются люди на арбайт, сдаётся ванрум 400/1 млн, комната большая, выход завтра',
    // Ruble-denominated micro-gigs are REAL in this corpus — must pass (ruble amounts dropped).
    'Разгрузить прицеп с материалами — 7100₽ сразу',
    'Работа курьером - 20 000р в день, на покушать и на дорогу перед работой скину',
    'Задание для девочек - 5000р',
    // 🔞 used as an age note ("16+"), not adult content — must pass (🔞 rule dropped).
    'Новые места на подработку, заработок 6000–7000 в час, 🔞 можно с 16 лет, пиши',
    // Casual "тема" and "обмен опытом" must not trip the tightened g1 / existing обмен combo.
    'Хорошая тема для стабильного заработка на заводе, обмен опытом с бригадой, виза E-9',
    // A real ad mentioning a flight (kg luggage) but not the ticket-agency pattern.
    'Работа на ферме, проживание и питание, поможем с билетом, оплата еженедельно',
  ];
  for (const s of ok) {
    it(`keeps: ${s.slice(0, 42)}`, () => {
      expect(looksLikeSpam(s)).toBe(false);
    });
  }
});
