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
  ];
  for (const s of ok) {
    it(`keeps: ${s.slice(0, 40)}`, () => {
      expect(looksLikeAdSpam(s)).toBe(false);
    });
  }
});
