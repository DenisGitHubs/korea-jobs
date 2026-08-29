// lib/korea/ads/adspam.test.ts
//
// The deterministic anti-ad backstop must reject explicit promo/spam while NEVER touching a
// legitimate Korea manual-labour ad. The negative set intentionally includes the collisions we
// engineered around: the wage sense of "ставка", caregiving "интимная гигиена", and the owner's
// example "оплата за трудоустройство с первой зарплаты".

import { describe, it, expect } from 'vitest';
import { looksLikeAdSpam } from './adspam.js';

describe('looksLikeAdSpam — advertising/spam must be caught', () => {
  const spam: string[] = [
    'Подпишись на наш канал и получи бонус',
    'Реклама лучших товаров со скидкой 50%',
    'Промокод KOREA на скидку в нашем магазине',
    'Онлайн казино с бонусом за регистрацию',
    'Ставки на спорт, надёжный букмекер, фрибет новичкам',
    'Инвестиции в криптовалюту — пассивный доход без вложений',
    'Заработок в интернете от 500 долларов в день',
    'Розыгрыш призов и giveaway, накрутка подписчиков недорого',
    'Эскорт услуги 18+, оплата почасовая',
  ];
  for (const s of spam) {
    it(`rejects: ${s.slice(0, 40)}`, () => {
      expect(looksLikeAdSpam(s)).toBe(true);
    });
  }
});

// --- CRIMINAL HIRING / money mules (ported from the parser filter 2026-08-19). A recruiter can type
// this straight into the "Разместить" form, where until now NO deterministic rule met it. One positive
// per ported pattern, each in a LIVING word form ("обналичка", not the bare stem "обнал") — a stem-only
// example would have passed the broken parser rules too and proved nothing.
describe('looksLikeAdSpam — criminal hiring (обнал / дропы / аренда карт) must be caught', () => {
  const spam: Array<[string, string]> = [
    ['обнал',         'Обналичка карт, оплата сразу, работаем по всей Корее'],
    ['дропы',         'Нужны дропы на карты, 300к в неделю, пиши в лс'],
    ['аренда карт',   'Аренда карт, плачу за каждую, деньги в тот же день'],
    ['счета аренда',  'Счета в аренду, ежедневная оплата, помощь с оформлением'],
    ['перестановка',  'Перестановка средств между картами, процент высокий'],
    ['доплата крипт', 'Доплата за usdt каждому исполнителю'],
  ];
  for (const [name, s] of spam) {
    it(`rejects (${name}): ${s.slice(0, 34)}`, () => {
      expect(looksLikeAdSpam(s)).toBe(true);
    });
  }
});

describe('looksLikeAdSpam — real vacancies must pass', () => {
  const ok: string[] = [
    'Требуется рабочий на завод в Ансане, зарплата 2 500 000 вон, жильё есть',
    'Стройка в Сеуле, вахта, оплата еженедельно, виза E-9',
    'Ферма, сбор клубники, питание и проживание предоставляется',
    'Уборка в отеле, почасовая ставка 12000 вон, стабильный график',
    'Уход за пожилыми: помощь по дому, интимная гигиена, питание включено',
    'Оплата за трудоустройство с первой зарплаты',
    'Рыбзавод, работа в смену, достойная зарплата, подработка по выходным',
    'Склад, погрузка-разгрузка, отработка стабильная, оформление по визе',
    // Collisions engineered around by the criminal-hiring block above (2026-08-19): the CARD tail is
    // an explicit ending list, so real words that merely start with "карт" are spared, and "дроп" is
    // bounded on both sides so it cannot fire inside a longer word.
    'Упаковка картона на складе, аренда спецтехники за счёт работодателя, 12000 вон в час',
    'Ферма, аренда картофельного поля у хозяина, нужны рабочие на сбор урожая',
    'Теплица с гидропоникой в Ансане, нужны работники, проживание рядом',
    'Оплата наличными в день выхода, завод в Пусане, виза любая',
  ];
  for (const s of ok) {
    it(`keeps: ${s.slice(0, 40)}`, () => {
      expect(looksLikeAdSpam(s)).toBe(false);
    });
  }
});
