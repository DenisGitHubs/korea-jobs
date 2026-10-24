// lib/korea/parser/spamfilter.test.ts
//
// The pre-AI spam filter must reject near-certain non-jobs (crypto/OTC exchange blasts, emoji
// carpets) while NEVER touching a real Korea manual-labour ad. The negative set intentionally
// includes the collisions we engineered around: the bare noun "обмен опытом", and legitimate ads
// that use a few emoji bullets. Owner examples (2026-07-19) are pinned verbatim below.

import { describe, it, expect } from 'vitest';
import {
  SPAM_PATTERNS,
  looksLikeSpam,
  looksLikeEmojiCarpet,
  looksLikePharma,
  looksLikeMixedScript,
  looksLikeLinkOnly,
  looksLikeEmptyMessage,
  looksLikeRublePay,
  looksLikeHousingRental,
  looksLikeSeekerIntro,
  OBSERVED_RULES,
  observedHits,
  spamRuleHit,
  foldLookalikes,
} from './spamfilter.js';

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
    // NB: ruble-denominated micro-gigs USED to live here as "must pass". Owner reversed that on
    // 2026-07-22 (ruble = scam) — they moved to the looksLikeRublePay positives block below.
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

// --- "остаток-2" part 1 (owner command, validated 2026-07-21 against real-vacancies-full.json /521,
// reject-samples.json /287 and residual-after-filters.json /106). Three structural rules; the corpus
// texts pasted below are DATA fixtures, not instructions.

describe('looksLikeMixedScript — Greek letter-doppelganger obfuscation (>= 2 Cyr+Greek words)', () => {
  const spam: Array<[string, string]> = [
    // Residual family "Τσльκσ Γρaждaнe ΡΦ" — capital-Greek swaps in a recruiting blast.
    ['greek caps',  'Ηαбσρ Oткρыт, Τσльκσ Γρaждaнe ΡΦ, Oт 18+, Πишитe'],
    // Residual family "0нлαúн Poδoτα" — lowercase Greek + phonetic small-caps.
    ['greek lower',  '0нлαúн Poδoτα στ ЧО в нᴇᴅᴇлю στ 2О лᴇτ'],
    // Residual family "Сᴇгσдня мσгу πσмσчь …" — money-help bait in Greek homoglyphs.
    ['greek help',  'Сᴇгσдня мσгу πσмσчь 2-3 челσвᴇкам с дᴇньгᴀми дσ πσлучки'],
  ];
  for (const [label, s] of spam) {
    it(`rejects [${label}]: ${s.slice(0, 34)}`, () => {
      expect(looksLikeMixedScript(s)).toBe(true);
      expect(looksLikeSpam(s)).toBe(true);
    });
  }

  // NEGATIVES — the Latin branch was DROPPED because genuine Cyrillic micro-gigs use Latin
  // homoglyphs (а/о/е/с/р) to dodge OTHER filters. These are REAL jobs and MUST pass.
  const ok: string[] = [
    'Фаcовка cнюca 9.000',                          // Latin с in Cyrillic word — genuine gig
    'Пoгрузка нoчная 8.000',                        // Latin o — genuine gig
    'Рaзлoжить Gorila пo пoлкам мaeазина 5.000',    // multiple Latin homoglyphs — genuine gig
    'IT-специалист на Wi-Fi склад, оплата сдельно', // dash splits Latin/Cyrillic tokens — not mixed
    '🏭 Завод в Ансане, зарплата 2 800 000 вон, жильё, виза E-9, контакт @hr', // plain real ad
    '안전 교육 필요, работа на заводе, виза E-9',        // Korean (Hangul) mixed with Cyrillic — not Greek
  ];
  for (const s of ok) {
    it(`keeps: ${s.slice(0, 40)}`, () => {
      expect(looksLikeMixedScript(s)).toBe(false);
    });
  }

  it('a single Greek homoglyph word is below the >= 2 threshold', () => {
    expect(looksLikeMixedScript('Работа на σклад, оплата достойная, виза E-9')).toBe(false);
  });
});

describe('looksLikeLinkOnly — message is nothing but a URL', () => {
  const spam: string[] = [
    'https://t.me/G1ramm',            // owner example (posted x3)
    '  https://t.me/G1ramm  ',        // surrounding whitespace stripped
    't.me/somechannel',              // bare t.me without scheme
    'http://example.com/promo',      // plain http
  ];
  for (const s of spam) {
    it(`rejects: ${s.slice(0, 30)}`, () => {
      expect(looksLikeLinkOnly(s)).toBe(true);
      expect(looksLikeSpam(s)).toBe(true);
    });
  }
  const ok: string[] = [
    'Пишите в личку https://t.me/hr_ansan по вакансии на завод', // real ad WITH a link — keeps letters
    'Требуется рабочий на ферму, оплата еженедельно',            // no URL at all
  ];
  for (const s of ok) {
    it(`keeps: ${s.slice(0, 30)}`, () => {
      expect(looksLikeLinkOnly(s)).toBe(false);
    });
  }
});

describe('looksLikeEmptyMessage — no letters, or exactly one greeting', () => {
  // (a) no Cyrillic/Latin/Hangul letter anywhere — only emoji/signs/digits.
  const noLetters: string[] = ['💋', '💞🔞', '❤️🔥', '01072771369', '+82 10-1234-5678'];
  for (const s of noLetters) {
    it(`rejects [no-letters]: ${JSON.stringify(s)}`, () => {
      expect(looksLikeEmptyMessage(s)).toBe(true);
      expect(looksLikeSpam(s)).toBe(true);
    });
  }
  // (b) whole message is exactly one greeting (after trimming punctuation/emoji).
  const greetings: string[] = ['Привет', 'привет!', 'Здравствуйте', 'Салам', 'ассалому алейкум',
    'Hi', 'Hello', 'raxmat', 'Рахмат', 'Спасибо', '👋 Привет'];
  for (const s of greetings) {
    it(`rejects [greeting]: ${JSON.stringify(s)}`, () => {
      expect(looksLikeEmptyMessage(s)).toBe(true);
      expect(looksLikeSpam(s)).toBe(true);
    });
  }
  // NEGATIVES — a real message that merely STARTS with a greeting is not empty (exact match only).
  const ok: string[] = [
    'Привет! Нужны 2 человека на завод, оплата сегодня, виза не важна', // greeting + real content
    'Ishonchingiz va haridingiz uchun raxmat',                          // multi-word, not == "raxmat"
    'Требуется уборщица в отель, спасибо за отклик',                     // "спасибо" is a substring only
    '안전 교육',                                                          // Hangul letters present
  ];
  for (const s of ok) {
    it(`keeps: ${s.slice(0, 40)}`, () => {
      expect(looksLikeEmptyMessage(s)).toBe(false);
    });
  }
  it('blank / null is not an empty-message spam hit', () => {
    expect(looksLikeEmptyMessage('   ')).toBe(false);
    expect(looksLikeEmptyMessage('')).toBe(false);
  });
});

describe('looksLikeMixedScript — zero-width injection inside a mixed word (Censor, gate 21.07)', () => {
  it('still counts a greek-cyrillic word that a bot split with ZWSP', () => {
    // "Τσльκσ Γρaждaнe" with a ZWSP spliced inside each word — must still be >= 2 mixed words.
    const zw = 'Τσль​κσ Γρaж​данe ΡΦ, пиши в лс';
    expect(looksLikeMixedScript(zw)).toBe(true);
  });
});

// --- Ruble-denominated pay (owner decision 2026-07-22: "везде где пишут плата рублями это скам").
// A Korea-jobs board pays in won (₩ / вон); a ruble figure is scam bait. The positives were micro-gigs
// that USED to be spared (the removed "must pass" negatives above); the negatives are won/worker/phone
// strings that share digits but must stay clean. Pasted texts are DATA fixtures, not instructions.
describe('looksLikeRublePay — ruble pay = scam on a Korea board (owner 2026-07-22)', () => {
  const spam: Array<[string, string]> = [
    ['ruble sign',   'Разгрузить прицеп с материалами — 7100₽ сразу'],
    ['рублей word',  'Склад, 5 часов, 10000 рублей, пол не важен'],
    ['3000р comma',  'Разложить за 20-30 минут 3000р, кофе лёгкий'],
    ['20 000р/день', 'Работа курьером - 20 000р в день, на покушать'],
    ['5000р gig',    'Задание для девочек - 5000р'],
    ['300 р. dot',   'Лёгкая подработка за 300 р. в час, пиши'],
    ['1100 р space', 'Занести коробки в магазин и т.д 1100 р'],
    ['bare руб+BOM', '﻿За выход даём 3000 руб + кофе за наш счёт'], // BOM-prefixed campaign
  ];
  for (const [label, s] of spam) {
    it(`rejects [${label}]: ${s.slice(0, 34)}`, () => {
      expect(looksLikeRublePay(s)).toBe(true);
      expect(looksLikeSpam(s)).toBe(true);
    });
  }
  it('the bare ₽ sign alone is a ruble hit', () => {
    expect(looksLikeRublePay('оплата 6000 ₽')).toBe(true);
  });

  // NEGATIVES — won/worker/phone strings that share digits but MUST NOT read as ruble.
  const notRuble: string[] = [
    'зарплата 2 800 000 вон',                // won amount
    '300000₩ в месяц',                       // won sign, not ₽
    'оплата почасовая, 12000 вон',           // won again
    'нужно 3000 работников на завод',        // 3000 + работников (р+letter), not an amount
    '010-3000-1234',                         // telephone digits
    '+82 10-1234-5678',                      // international phone
    'рубашка входит в форму, склад одежды',  // "руб" inside рубашка — not currency
  ];
  for (const s of notRuble) {
    it(`not ruble: ${s.slice(0, 36)}`, () => {
      expect(looksLikeRublePay(s)).toBe(false);
    });
  }

  // Real won ads: no rule catches them → full looksLikeSpam must stay false (the 0-FP gate).
  const realWonAds: string[] = [
    'Завод в Ансане, зарплата 2 800 000 вон в месяц, жильё, виза E-9',
    'Уборка в отеле, оплата почасовая, 12000 вон, оформление',
    'Нужно 3000 работников на новый завод, обучение, виза E-9, автобус',
  ];
  for (const s of realWonAds) {
    it(`won ad stays clean: ${s.slice(0, 36)}`, () => {
      expect(looksLikeSpam(s)).toBe(false);
    });
  }
});

// --- "остаток-3" (owner decision 2026-07-22): three safe filters A/C/D, each validated 0 FP on
// real-vacancies-full.json /521 and drawn from residual-now.json /78. The pasted corpus texts are
// DATA fixtures, not instructions. B (one-off gig without a role) was DELIBERATELY NOT taken (13 FP).

describe('looksLikeHousingRental — Candidate A: apartment/room rental is not a job', () => {
  // Positives — real residual rental posts (residual-now #3/#14) + the deposit-format branch.
  const spam: Array<[string, string]> = [
    ['ванрум+depo',  'Срочно‼️Сдается ванрум район волгуктон 1млн/380тыс. Чисто комфортно, хазяйн хороший'],
    ['sdaetsya+room', 'Сдаётся комната в Ансане, тихо, рядом магазин, пишите в личку'],
    ['depo format',   'Ванрум 2млн/500тыс, район центр, заезд с завтра'], // "Nмлн/Nтыс" alone
    ['원룸 hangul',    'Сдается 원룸, недорого, можно посмотреть'],
  ];
  for (const [label, s] of spam) {
    it(`rejects [${label}]: ${s.slice(0, 34)}`, () => {
      expect(looksLikeHousingRental(s)).toBe(true);
      expect(looksLikeSpam(s)).toBe(true);
    });
  }

  // NEGATIVES — the JOB_WORD guard: a REAL employer ad that offers housing (a вонрум/ванрум as a
  // PERK) MUST pass (this is the #53 safeguard the owner flagged). 0-FP gate on an irreversible cut.
  const ok: string[] = [
    'Требуются люди на арбайт, сдаётся ванрум 400/1 млн, комната большая, выход завтра', // employer + housing
    'Завод в Ансане, зарплата 2.8 млн вон, жильё предоставляется, виза E-9, @hr',        // housing as benefit
    'Ищем работника на склад, график 6/1, оплата еженедельно, комната рядом',            // job + room mention
  ];
  for (const s of ok) {
    it(`keeps: ${s.slice(0, 42)}`, () => {
      expect(looksLikeHousingRental(s)).toBe(false);
      expect(looksLikeSpam(s)).toBe(false);
    });
  }

  // JOB_WORD now catches the SINGULAR "нужен работник" (Censor «остаток-3»). Before, "нужны?" missed
  // "нужен", so an employer ad whose ONLY offer signal is "нужен работник" fell through the guard and
  // was wrongly cut as housing. It MUST be spared now.
  it('spares an employer ad whose only job word is the SINGULAR "нужен работник"', () => {
    const ad = 'Нужен работник на склад, сдаётся ванрум для сотрудников';
    expect(looksLikeHousingRental(ad)).toBe(false); // job word wins → not housing
    expect(looksLikeSpam(ad)).toBe(false);
  });

  // RENT_HOUSE_N kept its left boundary without narrowing the real catch: a dwelling noun preceded by
  // a non-letter (space, dash) still fires when there is no job word.
  it('still catches a plain rental after the boundary tighten', () => {
    expect(looksLikeHousingRental('Сдаётся 1-комнатная квартира в Ансане, недорого')).toBe(true);
    expect(looksLikeHousingRental('Сдается жильё рядом с заводом, можно посмотреть')).toBe(true);
  });
});

describe('looksLikeSeekerIntro — Candidate C: short first-person job-seeker self-intro', () => {
  // Positives — real residual seeker one-liners (residual-now #65-69, #71), all ≤6 words.
  const spam: Array<[string, string]> = [
    ['zovut',     'Меня зовут Мукхаммад'],
    ['age',       'Мне 24 лет'],
    ['grazhdanin','Я из гражданин Узбекистана'],
    ['v seychas', 'Я в сейчас Узбекистана'],
    ['net vizy',  'У меня нет виза'],
    ['net deneg', 'У меня нет денег'],
    ['iz stan',   'Я из Узбекистан'],
  ];
  for (const [label, s] of spam) {
    it(`rejects [${label}]: ${s.slice(0, 34)}`, () => {
      expect(looksLikeSeekerIntro(s)).toBe(true);
      expect(looksLikeSpam(s)).toBe(true);
    });
  }

  // NEGATIVES — the hard LENGTH gate (≤6 words): a LONGER first-person seeker paragraph is NOT cut by
  // C (it goes to the AI), and a real vacancy is never touched. This is the exact "длинное
  // объявление-соискатель НЕ ловится C" case the owner asked to prove.
  const ok: string[] = [
    'Меня зовут Иван, мне 30 лет, ищу работу сварщиком на заводе в Ансане, есть виза F4', // long intro -> AI
    'Завод в Ансане, зарплата 2 800 000 вон, жильё, виза E-9, контакт @hr_ansan',          // real ad
    'Требуется рабочий на ферму, сбор урожая, проживание рядом, оплата еженедельно',       // real ad
  ];
  for (const s of ok) {
    it(`keeps: ${s.slice(0, 42)}`, () => {
      expect(looksLikeSeekerIntro(s)).toBe(false);
    });
  }
  it('long seeker paragraph is not spam via C (length gate lets it reach the AI)', () => {
    expect(looksLikeSpam('Меня зовут Иван, мне 30 лет, ищу работу сварщиком на заводе, есть виза F4')).toBe(false);
  });
});

describe('looksLikeSpam — Candidate D: first-person job-seeker requests (SPAM_PATTERNS)', () => {
  // Positives — real residual seeker requests (residual-now #64/#74/#75) + the other exact phrasings.
  const spam: Array<[string, string]> = [
    ['hochu',     'Я хочу поехать на работу в Корее'],
    ['priglash',  'Мне нужно приглашение'],
    ['oplachu',   'Пожалуйста, помогите мне со всеми расходами; я оплачу их из своей зарплаты.'],
    ['pomogite',  'Помогите мне со всеми расходами, я студент'],
  ];
  for (const [label, s] of spam) {
    it(`rejects [${label}]: ${s.slice(0, 34)}`, () => {
      expect(looksLikeSpam(s)).toBe(true);
    });
  }

  // NEGATIVES — a real EMPLOYER ad that shares vocabulary (приглашение / оплата / зарплата) but is an
  // OFFER, not a first-person seeker request, must pass.
  const ok: string[] = [
    'Требуется рабочий на завод, оформим приглашение и визу, зарплата 2.8 млн вон',   // employer offers invite
    'Стройка в Сеуле, оплата еженедельно, жильё, виза E-9, звоните @hr',              // "оплата" but not "оплачу из зп"
    'Ищем 3 человек на ферму, поможем со всеми документами, проживание рядом',        // "поможем", not "помогите мне"
  ];
  for (const s of ok) {
    it(`keeps: ${s.slice(0, 42)}`, () => {
      expect(looksLikeSpam(s)).toBe(false);
    });
  }

  // "зп" tail — Cyrillic-safe (?![а-яё]) boundary, NOT ASCII \b (Censor «остаток-3»). "оплачу … зп"
  // ends the token on a space/EOL, where a \b after the Cyrillic "п" never matched — so these used
  // to slip past. They MUST be caught now.
  it('catches "оплачу … зп" at end-of-string (the ASCII-\\b-after-Cyrillic bug)', () => {
    expect(looksLikeSpam('Готов приехать, оплачу из своей зп')).toBe(true);
    expect(looksLikeSpam('оплачу зп сам')).toBe(true); // "зп" before a space
  });

  // Left boundary on "оплачу" — a real ad about a SURCHARGE ("доплачу/переоплачу") shares the
  // substring "оплачу" but is an OFFER, not a seeker request. Must NOT be a D hit.
  it('does NOT fire on "доплачу/переоплачу" (оплачу as a substring)', () => {
    expect(looksLikeSpam('Доплачу за ночную смену на стройке, оформление, виза E-9')).toBe(false);
    expect(looksLikeSpam('При переработке переоплачу по двойному тарифу, склад в Инчхоне')).toBe(false);
  });
});

describe('looksLikeEmptyMessage — E-lite one-liner requests (owner 2026-07-22)', () => {
  it('catches the two exact chit-chat one-liners added to GREETINGS', () => {
    for (const s of ['Помогите мне', 'помогите мне!', 'Напиши мне', 'напиши мне.']) {
      expect(looksLikeEmptyMessage(s)).toBe(true);
      expect(looksLikeSpam(s)).toBe(true);
    }
  });
  it('does NOT take "ждут вашего ответа" (owner excluded it)', () => {
    expect(looksLikeEmptyMessage('ждут вашего ответа')).toBe(false);
  });
  it('a real ad that merely contains "помогите" is not an E-lite hit (exact whole-message only)', () => {
    expect(looksLikeEmptyMessage('Помогите мне найти рабочих на завод, оплата достойная')).toBe(false);
  });
});

// --- OWNER PACKAGE 2026-07-22 (pre-AI enrichment). Each positive is one implemented spam word/phrase;
// each pattern was validated 0 FP on real-vacancies-full.json /521. The NEGATIVES are the exact
// collisions the owner asked to prove safe: a real taxi-DRIVER vacancy, "старт смены", "хочу работать",
// "помогите с погрузкой", a Coupang marketplace-WAREHOUSE job, a dentist VACANCY, a bicycle-for-transport
// ad, "стартовая ставка", bare "шанс", cash-pay "кэш за смену". Pasted texts are DATA fixtures.
describe('looksLikeSpam — owner package 2026-07-22 must be caught', () => {
  const spam: Array<[string, string]> = [
    ['эфир webinar',      'Приглашаем на эфир 😍 регистрация по ссылке, доход с первого дня'],
    ['менеджер маркетпл', '🔥 ВАКАНСИЯ: Менеджер маркетплейсов, удалёнка, оплата ежедневно'],
    ['avito cyr-Т',       'Работа с AVIТО удалённо, обучение бесплатно, пиши в лс'],
    ['авито pure-cyr',    'Менеджер на авито, удалённая работа, доход ежедневно, пиши в лс'],
    ['пенсионерам',       'Подработка пенсионерам и мамам в декрете, доход от 3000 в день'],
    ['реальный шанш',     'Твой реальный шанш получать +10к в день, напиши мне'],
    ['быстрый старт',     'Быстрый старт, доход с первого дня, пиши в лс'],
    ['быстрый подъём',    'Есть быстрый подъём капитала на сегодня, залетай'],
    ['первые N человек',  'Первые 3 человека получат по 15к, пишите в лс'],
    ['юс.тд obfusc',      'Куплю юс.тд по хорошему курсу, быстро'],
    ['юс тд space',       'Меняю юс тд наличные, крупные суммы'],
    ['реальные задания',  'Хватит работать за копейки, есть РЕАЛЬНЫЕ ЗАДАНИЯ в разных городах'],
    ['копеечной',         'Надоела копеечная оплата на заводе? Есть вариант получше'],
    ['без вложений',      'Заработок без вложений, доход от 20к в неделю, пиши'],
    ['без криминала',     'Всё легально, без криминала и мутных схем, залетай'],
    ['мутных схем',       'Чистый заработок, никаких мутных схем, доход ежедневно'],
    ['напиши свой город', 'Набор в команду, напиши свой город и + в лс'],
    ['если нужны деньги', 'Если нужны деньги — есть тема, пиши в личку'],
    ['не женат справка',  'Все документы качественные: не женат справка, водительские права'],
    ['цитрамон',          'В наличии таблетки: цитрамон, каптоприл, доставка по всей Корее'],
    ['такси недорого',    'Такси по Корее недорого, любой город, звоните'],
    ['вкусным ценам',     'Нарядные платья от корейских брендов по вкусным ценам, заказывай'],
    ['стоматология',      'Стоматология в Ансане — клиника вашей улыбки, имплантация и ортодонтия'],
    ['продаём велосипед', 'Продаём велосипед детский, почти новый, отдаём за 150 тысяч'],
  ];
  for (const [label, s] of spam) {
    it(`rejects [${label}]: ${s.slice(0, 34)}`, () => {
      expect(looksLikeSpam(s)).toBe(true);
    });
  }

  // CRITICAL NEGATIVES — the exact real-vacancy collisions the owner flagged. Each MUST pass (the
  // irreversible-filter 0-FP gate). A silent false drop here kills a genuine job.
  const ok: string[] = [
    'Нужен таксист в Ансане, своя машина, оплата ежедневно, график свободный', // taxi DRIVER vacancy
    'Работа в такси по городу, требуется водитель с визой, доход хороший',      // taxi driver vacancy #2
    'Старт смены в 8 утра, завод в Ансане, оплата еженедельно, жильё',          // "старт смены" (bare старт)
    'Хочу работать на заводе в Корее, есть опыт, готов приехать',               // "хочу работать" (bare хочу)
    'Помогите с погрузкой, нужны 2 грузчика на сегодня, оплата сразу',          // "помогите" as a real gig
    'Склад маркетплейса Coupang в Инчхоне, упаковка заказов, зарплата 2.7 млн вон', // Coupang warehouse job
    'Требуется стоматолог-ассистент в клинику, виза E-7, зарплата высокая',     // dentist VACANCY (not clinic ad)
    'Завод в Хвасоне, рекомендуется велосипед для передвижения, виза E-9',      // bicycle for transport (bare)
    'Стартовая ставка 125 000 вон за смену, завод в Кёнгидо, оформление',       // "стартовая" (bare старт)
    'Хороший шанс устроиться на стабильную работу в Сеуле, звоните',            // bare "шанс"
    'Плачу кэш за смену, стройка в Сеуле, оплата в тот же день',                // "кэш за" cash-pay (dropped)
    'Требуется менеджер склада, разгрузка фур, зарплата 2.8 млн вон',           // "менеджер" not "менеджер маркетпл"
  ];
  for (const s of ok) {
    it(`keeps: ${s.slice(0, 42)}`, () => {
      expect(looksLikeSpam(s)).toBe(false);
    });
  }
});

// --- REVIVED RULES 2026-08-19 (Roma). The FIRST pattern block of spamfilter.ts was written with raw
// \w / \b, which in JS are ASCII-only — seven alternatives next to Cyrillic matched NOTHING, and the
// whole money-mule class (обнал / дропы / аренда карт) was silently off. Every phrase below is a LIVING
// word form ("обналичка", "дропы", "аренда карт"), because the broken rules DID match their bare stems
// ("обнал карт", "аренд карт") — a stem-shaped test would have been green on the dead code and proved
// nothing. Asserted through looksLikeSpam (the whole filter), never a single regex.
describe('looksLikeSpam — revived \\w/\\b rules must catch the living word forms', () => {
  const spam: Array<[string, string]> = [
    ['обналичка',       'обналичка карт, оплата сразу'],
    ['дропы',           'нужны дропы на карты, 300к в неделю'],
    ['аренда карт',     'аренда карт, плачу за каждую'],
    ['перестановка',    'перестановка средств между картами'],
    ['обнал %',         'обнал 15%, работаем по всей корее'],
    ['доплата за usdt', 'доплата за usdt'],
    ['рубли на воны',   'меняю рубли на воны'],
  ];
  for (const [label, s] of spam) {
    it(`rejects [${label}]: ${s.slice(0, 34)}`, () => {
      expect(looksLikeSpam(s)).toBe(true);
    });
  }

  // SHADOW CHECK (the trap this batch was warned about): two of the seven phrases are ALSO caught by a
  // neighbour, so a green looksLikeSpam alone does not prove the revived rule itself works.
  //   • "меняю рубли на воны" — looksLikeRublePay (a SEPARATE function) fires on any рубл* form, so the
  //     assertion below asks the PATTERN ARRAY (still the whole set, minus the structural heuristics)
  //     whether it matches. Before the fix it did not.
  //   • "доплата за usdt" — the bare-usdt rule catches the usdt half regardless, so the probe below uses
  //     the crypto half in a form the live re('крипт[оауеы][а-яё]*') rule does NOT cover (no vowel after
  //     the stem): only the revived доплат* rule can match it.
  it('рубли→воны is matched by the PATTERN SET itself, not only by looksLikeRublePay', () => {
    expect(SPAM_PATTERNS.some((rx) => rx.test('меняю рубли на воны'))).toBe(true);
  });
  it('the revived доплат* rule fires on its own (crypto half, not the bare-usdt neighbour)', () => {
    expect(looksLikeSpam('доплата за крипт по курсу')).toBe(true);
  });

  // NEGATIVES for the newly revived patterns — the 0-FP gate on an irreversible filter. Real ads that
  // merely START with the same letters ("картон / картофель / гидропоника") and a plain won salary must
  // all pass; a won amount is never spam (the ruble rule is what watches currency).
  const ok: string[] = [
    'Завод в Ансане, зарплата 2 500 000 вон в месяц, жильё и питание, виза E-9',
    'Стройка в Сеуле, оплата 150 000 вон в день, вахта, жильё предоставляется',
    'Теплица с гидропоникой в Чхонане, нужны работники, проживание рядом',
    'Упаковка картона на складе, 12 000 вон в час, автобус от общежития',
    'Ферма, аренда картофельного поля у хозяина, нужны рабочие на сбор урожая',
    'Уборка в отеле, аренда формы за счёт работодателя, стабильный график',
    'Требуется водитель с картой водителя, доставка по Сеулу, 2 800 000 вон',
    'Оплата наличными в день выхода, завод в Пусане, виза любая',
  ];
  for (const s of ok) {
    it(`keeps: ${s.slice(0, 42)}`, () => {
      expect(looksLikeSpam(s)).toBe(false);
    });
  }
});

// --- MULTILINE regression (gate 2026-08-19). Not one fixture in this file had a line break, yet the
// user-ad path ALWAYS feeds a multi-line string (ads/input.ts adModText joins six form fields with
// "\n", "housing terms" right next to "meals"). A plain \s+ inside a multi-word rule bridges those two
// lines, so "…в аренду⏎Карточка иностранца…" — two unrelated fields — read as the mule phrase
// "аренда карт". Every negative below carries a JOB WORD on purpose: without one,
// looksLikeHousingRental legitimately fires on "сдаётся … комната" and the fixture would be testing
// the housing rule instead of this one.
describe('looksLikeSpam — a rule must NOT bridge a line break (multiline form text)', () => {
  const ok: string[] = [
    'Требуется рабочий на завод\nЖильё: комната в аренду\nКарточка иностранца обязательна',
    'Нужны люди на склад\nСпецодежда в аренду\nКарты доступа выдаём на проходной',
    // The same bridge in the OTHER direction ("счёт" + "в аренду"), which the old g3 rule allowed.
    'Требуется рабочий на завод в Ансане\nПитание: за свой счёт\nВ аренду сдаётся комната рядом',
    // A full six-field form text — the exact shape the classifier sees on the ad path.
    'Завод в Ансане\nСборка автозапчастей, нужны рабочие\n2 500 000 вон в месяц\n5/2, смена 10 часов\nЖильё: комната в аренду\nКарточка иностранца обязательна',
  ];
  for (const s of ok) {
    it(`keeps (multiline): ${s.slice(0, 34).replace(/\n/g, ' | ')}`, () => {
      expect(looksLikeSpam(s)).toBe(false);
    });
  }

  it('still catches the mule phrase when it sits on ONE line of a multiline post', () => {
    expect(looksLikeSpam('Работа для всех\nОбналичка карт, оплата сразу\nПиши в лс')).toBe(true);
  });
});

// --- The criminal_hiring vocabulary the PROMPT names must also be caught by the cheap filter (gate
// 2026-08-19). "карты в аренду" (reverse order) and "дроповод" were named in the prompt instruction as
// tells but matched NOTHING here: the rule had "аренда карт" forward-only, and the дроп tail was too
// short for "дроповода". A word the prompt calls a tell and the filter ignores is the gap the recruiter
// walks through — and the filter is the half that runs first and costs nothing.
describe('looksLikeSpam — the criminal-hiring vocabulary named in the prompt', () => {
  // The zero-width char is written as an ESCAPE, not pasted invisibly, so the fixture stays reviewable.
  const ZW = '\u2060'; // word-joiner (escape, so the fixture stays visible in review)
  const spam: Array<[string, string]> = [
    ['карты в аренду',   'карты в аренду, оплата сразу'],
    ['карты под аренду', 'карты под аренду, 300к в неделю'],
    ['счета в аренду',   'счета в аренду, ежедневные выплаты'],
    ['дроповод',         'ищу дроповода на постоянку'],
    ['дроповодами',      'работаем с дроповодами, процент высокий'],
    ['zero-width обнал', `об${ZW}нал 15%, работаем по всей корее`],
  ];
  for (const [label, s] of spam) {
    it(`rejects [${label}]: ${s.slice(0, 30)}`, () => {
      expect(looksLikeSpam(s)).toBe(true);
    });
  }

  // The widened frame must still not eat real words that merely start the same way.
  const ok: string[] = [
    'Требуется электрик, установка счётчиков воды, 3 000 000 вон, оформление',
    'Упаковка картриджей на складе, 12 000 вон в час, автобус',
    'Стройка, аренда инструмента за счёт работодателя, оплата в тот же день',
  ];
  for (const s of ok) {
    it(`keeps: ${s.slice(0, 42)}`, () => {
      expect(looksLikeSpam(s)).toBe(false);
    });
  }
});

// --- OBSERVED 2026-10-24: rules taken from what the model rejected (spamfilter.ts, OBSERVED block).
// SHADOW ONLY since the owner decision of 2026-10-24: they drop nothing, observedHits() names them.
// Every positive asserts the SPECIFIC rule by id (so a positive cannot stay green because some other
// rule happens to catch it — a guard must go red when its own rule is reverted), and every rule has a
// negative that is a real vacancy sharing its words. Fixtures are generalized templates of the live
// texts (no phones / handles).
describe('foldLookalikes — folds look-alikes only inside Cyrillic-bearing words', () => {
  it('folds Latin letters and 0/6 inside a Russian word', () => {
    expect(foldLookalikes('PAБOTУ OHЛAЙH')).toBe('работу онлайн');
    expect(foldLookalikes('П0купаю т0нджанки')).toBe('покупаю тонджанки');
    expect(foldLookalikes('Pa6отаем')).toBe('работаем');
  });
  it('leaves a token without Cyrillic byte-for-byte (Uzbek Latin, URLs, amounts)', () => {
    expect(foldLookalikes("Korea kartasi bo'lsa 2 500 000 von")).toBe("korea kartasi bo'lsa 2 500 000 von");
    expect(foldLookalikes('t.me/hr_ansan')).toBe('t.me/hr_ansan');
  });
  it('strips zero-width chars before folding', () => {
    expect(foldLookalikes('ра​бота')).toBe('работа');
  });
  // A 0/6 with a digit right next to it is part of a number, not a letter (2026-10-24).
  it('keeps a 0 whose LEFT neighbour is a digit (number glued to a unit)', () => {
    expect(foldLookalikes('трц20')).toBe('трц20');
    expect(foldLookalikes('500грн')).toBe('500грн');
  });
  it('keeps a 0/6 whose RIGHT neighbour is a digit', () => {
    expect(foldLookalikes('х06')).toBe('х06');
  });
});

describe('observedHits — OBSERVED 2026-10-24 rules (positive on the living form, by rule id)', () => {
  const spam: Array<[string, string]> = [
    ['o1a', 'Asalomu alaykum Koreya kartasi borlarga ish bor toliq malumot lichda'],
    ['o1b', 'Korea kartasi bor E9 akalarga daromadli ish bor malumot lich'],
    ['o1b', 'Karea bank karta bolsa pul ishlab olish taklifi'],
    ['o1c', 'Aslomu alaykum Korea karta sotib olamiz limiti katta bolsa foizga kelishamiz'],
    ['o1c', 'Kareya bank kartangiz boʻlsa pul ishlab oling'],
    ['o1c', 'Karta sotib olamiz, limiti katta bolsa foizga kelishamiz'], // owner-less "sotib" branch
    ['o1d', "Kareadan ketmoqchi bo'layotgan va ketib ulgurgan guruhdan bo'lib turganlar uchun taklif"],
    ['o1d', 'Koreyadan qaytmoqchi bolganlar uchun taklif bor'],
    ['o2a', 'бошки в наличии'],
    ['o2a', 'Есть проба мефа 0.5'],
    ['o2b', 'Дам на пробу 0.5'],
    ['o2b', 'ПРОБЫ ПО 1ГР'],
    ['o2b', 'Есть пробы по 0,5'], // "по" + decimal, no unit
    ['o2b', 'дам на деп'],
    ['o3', 'Здравствуйте, куплю юcдт за наличные'], // Latin "c" — the old /юсдт/ cannot see it
    ['o3', 'Покупаю ЮCД(трц20) - нал/безнал'],
    ['o3', 'Покупаю U.S.D.T. при личной встрече'],
    ['o4', 'П0купаю т0нджанки дорого'],
    ['o4', 'Куплю тонжан лимит от 1 миллион'],
    ['o5', 'PAБOTУ OHЛAЙH❗️ Опыт не важен — научу с нуля'],
    ['o5', 'Полностью онлайн работа, зп от 2000$'],
    ['o5', 'Онлайн-работу даём всем, зп от 2000$'],
    ['o6', 'Оставь 5 отзывов где я скажу, забери 1500 на карту'],
    ['o6', 'Пролайкать профиль спонсоров - 2000'],
    ['o7', 'закроем все твои должки'],
    ['o7', 'помогу финансово'],
    ['o7', 'Дам в займы.'],
    ['o8', 'Темка 15к в день'],
    ['o8', 'Кто хoчeт подзарaботать, есть движyха до 15500'], // look-alike "y" folded
    ['o9', 'Доход от 2000 грн на день. Деньги сразу'],
    ['o10', 'Подробности тут https://t.me/m/AbCdEf12'],
  ];
  for (const [id, s] of spam) {
    it(`${id} fires: ${s.slice(0, 40)}`, () => {
      expect(observedHits(s)).toContain(id);
    });
  }

  it('every OBSERVED rule has at least one positive above, and ids are unique', () => {
    const ids = OBSERVED_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(spam.map(([id]) => id))).toEqual(new Set(ids));
  });

  it('empty / null text has no hits', () => {
    expect(observedHits('')).toEqual([]);
    expect(observedHits(null)).toEqual([]);
  });
});

// Each branch of the 2026-10-24 fold fix and of the o3 alternation, one test apiece: reverting ONE branch
// turns exactly its own test red.
describe('observedHits — digit-guarded fold and every o3 branch', () => {
  it('o9 sees "500грн" (glued; the old fold read it as "5оогрн")', () => {
    expect(observedHits('Доход 500грн в день')).toContain('o9');
  });
  it('o9 sees "2000грн"', () => {
    expect(observedHits('Плачу 2000грн сразу')).toContain('o9');
  });
  it('o3 sees a bare "трц20" (the old fold read it as "трц2о")', () => {
    expect(observedHits('Принимаю трц20 по хорошему курсу')).toContain('o3');
  });
  it('o2b sees "по 10гр" (the old fold read it as "1огр")', () => {
    expect(observedHits('пробы по 10гр')).toContain('o2b');
  });
  it('o3 sees "юсд(" — the bracket branch', () => {
    expect(observedHits('Куплю юсд (трц) за нал')).toContain('o3');
  });
  it('o3 sees "ustd" — the transposed branch', () => {
    expect(observedHits('Куплю ustd за нал')).toContain('o3');
  });
});

describe('observedHits — narrowed rules stay quiet on the real ad next door (2026-10-24)', () => {
  const quiet: Array<[string, string]> = [
    ['o1a', 'ID kartasi borlarga ish bor, zavodga 3 ta ishchi kerak'],
    ['o1c', "ID karta bo'lsa olamiz, zavodga ishchi kerak"],
    ['o1c', 'ID karta sotib olamiz'], // the "id" guard on the owner-less branch
    ['o1c', 'ID-karta sotib olamiz'],
    ['o2b', 'проба 0,5 ставки, потом полная'], // a bare decimal is not a dose
    ['o2b', 'проба по 3 дня, потом постоянка'],
    ['o5', 'Склад, работа онлайн-магазина, 130 000 вон в день'],
    ['o5', 'Оплата за работу онлайн-переводом каждый день'],
    ['o5', 'Запись на работу онлайн через анкету, завод в Ансане'],
    ['o5', 'Сайт онлайн работает круглосуточно, завод в Ансане, 2 400 000 вон'],
    ['o5', 'Наш онлайн-работодатель платит вовремя, завод в Ансане'],
    ['o5', 'Запись онлайн работника на смену, завод в Ансане'],
  ];
  for (const [id, s] of quiet) {
    it(`${id} is quiet: ${s.slice(0, 40)}`, () => {
      expect(observedHits(s)).not.toContain(id);
      expect(looksLikeSpam(s)).toBe(false);
    });
  }
  it('o2b still fires when the same dose carries a unit ("проба 1г")', () => {
    expect(observedHits('Есть проба 1г')).toContain('o2b');
  });
});

describe('looksLikeSpam — the OBSERVED rules are shadow-only (owner 2026-10-24)', () => {
  // Texts that ONLY an OBSERVED rule recognizes: the live filter must let them through to the model.
  const shadowOnly = [
    'PAБOTУ OHЛAЙH❗️ Опыт не важен — научу с нуля',
    'Asalomu alaykum Koreya kartasi borlarga ish bor toliq malumot lichda',
    'закроем все твои должки',
    'Доход от 2000 грн на день. Деньги сразу',
  ];
  for (const s of shadowOnly) {
    it(`passes the live filter, hit is only recorded: ${s.slice(0, 36)}`, () => {
      expect(observedHits(s).length).toBeGreaterThan(0);
      expect(looksLikeSpam(s)).toBe(false);
      expect(spamRuleHit(s)).toBeNull();
    });
  }
});

describe('spamRuleHit — names the live rule that drops the message', () => {
  it('names a structural heuristic', () => {
    expect(spamRuleHit('💊💊 доставка по всей Корее')).toBe('pharma');
    expect(spamRuleHit('Подработка 3000₽ за вечер')).toBe('ruble');
    expect(spamRuleHit('Привет')).toBe('empty');
  });
  it('names a pattern as p<index>, and that index really is the pattern that fires', () => {
    const s = 'Меняю крипту на воны, быстро и надёжно';
    const id = spamRuleHit(s);
    expect(id).toMatch(/^p\d+$/);
    expect(SPAM_PATTERNS[Number(id!.slice(1))]!.test(s.toLowerCase())).toBe(true);
  });
  it('null on a real vacancy, null on empty input; agrees with looksLikeSpam', () => {
    const real = 'Завод в Ансане, 2 400 000 вон, общежитие, пишите в лс';
    expect(spamRuleHit(real)).toBeNull();
    expect(looksLikeSpam(real)).toBe(false);
    expect(spamRuleHit('')).toBeNull();
    expect(spamRuleHit(null)).toBeNull();
  });
});

describe('looksLikeSpam — OBSERVED 2026-10-24 rules spare the real vacancy next door', () => {
  const ok: string[] = [
    // o1 Uzbek: real Uzbek-Latin vacancies, incl. pay to a bank card and an ID card requirement.
    'Icheon Logen tekpeda doimiy ish bor, 40ta odamga, dushanbadan jumagacha 19:30 dan',
    'Ansan zavodga ishchi kerak, ish haqi har oy bank kartaga tushadi, 2 500 000 von',
    "Koreya ID kartasi bo'lishi shart, zavodga 2 ta ishchi kerak",
    // o2 drugs: pine-cone harvest (the reason "шишки" is NOT a rule), lime slaking, a probation period.
    'Сбор шишек и кедровых орехов, собирать шишки в лесу, 120 000 вон в день',
    'Гашение извести на стройке, 150 000 вон, оплата в день',
    'Пробный день оплачивается, проба 3 дня, потом постоянка на склад',
    'Возьмём на пробу двух парней на склад, 130 000 вон',
    // o4 a real ad that names the bank book.
    'Зарплата на тонджан, оформление официальное, завод в Хвасоне',
    // o5 "онлайн" next to a job word, but not "работа онлайн".
    'Собеседование онлайн, работа на заводе в Ансане, 2 400 000 вон',
    'Требуются рабочие на склад. Работа\nОнлайн собеседование по видео', // no line bridge
    // o6/o7 the same verbs on other objects.
    'Оставить заявку можно в лс, работа на складе, 12 000 вон в час',
    'Закрыть смену до 18:00, оплата в день, долг по зарплате не держим',
    // o8 a surname and "движение" are not scheme slang.
    'Требуется помощник Темкина на стройку, 150 000 вон',
    'Движение по графику 2/2, развоз есть, завод в Чхонане',
    // o9/o10 won pay; an ordinary t.me contact.
    'Оплата 2000 вон в час сверху за ночь, 5 грузчиков',
    'Завод в Ансане, пишите t.me/hr_ansan',
  ];
  for (const s of ok) {
    it(`keeps: ${s.slice(0, 44).replace(/\n/g, ' | ')}`, () => {
      expect(looksLikeSpam(s)).toBe(false);
      // Shadow rules must not even RECORD these — a hit here would put a real vacancy on the list
      // the owner switches on.
      expect(observedHits(s)).toEqual([]);
    });
  }
});
