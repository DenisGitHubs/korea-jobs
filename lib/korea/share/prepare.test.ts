// lib/korea/share/prepare.test.ts
//
// Pure-function coverage for the share-card composition. These strings reach a card anyone can
// forward, so the tests pin: (1) the localized copy (RU default, EN for en-*), (2) contacts are
// scrubbed out of the vacancy description and a part that scrubs to a redaction marker is DROPPED
// (never a stray " · " or "[скрыто]"), (3) the vacancy title is the localized "{role} — вакансия
// в Корее", (4) the app card uses the LEGAL-approved process wording (no outcome/guarantee),
// (5) resolveShareKind defaults to "vacancy" for back-compat.

import { describe, it, expect } from 'vitest';
import {
  buildVacancyCardText,
  buildAppCardText,
  resolveShareKind,
  pickCityName,
} from './prepare.js';
import { shareLocale } from './copy.js';

describe('resolveShareKind — default is vacancy (back-compat)', () => {
  it('absent kind -> vacancy', () => {
    expect(resolveShareKind(undefined)).toBe('vacancy');
    expect(resolveShareKind(null)).toBe('vacancy');
  });
  it('explicit "app" -> app', () => {
    expect(resolveShareKind('app')).toBe('app');
  });
  it('explicit "vacancy" -> vacancy', () => {
    expect(resolveShareKind('vacancy')).toBe('vacancy');
  });
  it('unknown value -> vacancy (then vacancyId validation applies)', () => {
    expect(resolveShareKind('APP')).toBe('vacancy');
    expect(resolveShareKind(42)).toBe('vacancy');
    expect(resolveShareKind({})).toBe('vacancy');
  });
});

describe('shareLocale — RU default, EN for en-*', () => {
  it.each([
    ['ru', 'ru'],
    ['ru-RU', 'ru'],
    ['ko', 'ru'], // unsupported card language falls back to RU
    ['uz', 'ru'],
    [undefined, 'ru'],
    [null, 'ru'],
    ['', 'ru'],
    ['en', 'en'],
    ['en-US', 'en'],
    ['EN', 'en'],
  ])('%s -> %s', (input, expected) => {
    expect(shareLocale(input as string | null | undefined)).toBe(expected);
  });
});

describe('pickCityName — localized city from jsonb', () => {
  const city = { ru: 'Ансан', ko: '안산', en: 'Ansan' };
  it('picks EN for the en locale', () => {
    expect(pickCityName(city, 'en')).toBe('Ansan');
  });
  it('picks RU for the ru locale', () => {
    expect(pickCityName(city, 'ru')).toBe('Ансан');
  });
  it('falls back to RU when the locale value is missing', () => {
    expect(pickCityName({ ru: 'Ансан' }, 'en')).toBe('Ансан');
  });
  it('returns null for a null / non-object / empty jsonb', () => {
    expect(pickCityName(null, 'ru')).toBeNull();
    expect(pickCityName('Ансан', 'ru')).toBeNull();
    expect(pickCityName({}, 'ru')).toBeNull();
  });
});

describe('buildVacancyCardText — title (role + country)', () => {
  it('RU: "{role} — вакансия в Корее"', () => {
    const { title } = buildVacancyCardText(
      { work_type: 'factory', city: 'Ансан', salary_text: null },
      'ru',
    );
    expect(title).toBe('Завод — вакансия в Корее');
  });
  it('EN: "{role} — job in Korea"', () => {
    const { title } = buildVacancyCardText(
      { work_type: 'construction', city: 'Seoul', salary_text: null },
      'en',
    );
    expect(title).toBe('Construction — job in Korea');
  });
});

describe('buildVacancyCardText — description (city · salary, scrubbed, empty-safe)', () => {
  it('joins city · salary', () => {
    const { description } = buildVacancyCardText(
      { work_type: 'factory', city: 'Ансан', salary_text: '2 500 000 вон' },
      'ru',
    );
    expect(description).toBe('Ансан · 2 500 000 вон');
  });

  it('keeps a big salary amount (money rescue) intact', () => {
    const { description } = buildVacancyCardText(
      { work_type: 'factory', city: 'Пусан', salary_text: 'зарплата 2500000 вон' },
      'ru',
    );
    expect(description).toContain('2500000');
    expect(description).not.toContain('[скрыто]');
  });

  it('drops a phone smuggled into salary, keeps the city, no stray separator', () => {
    const { description } = buildVacancyCardText(
      { work_type: 'factory', city: 'Инчхон', salary_text: '010-1234-5678' },
      'ru',
    );
    expect(description).toBe('Инчхон');
    expect(description).not.toContain('[скрыто]');
    expect(description).not.toContain('·');
  });

  it('is empty (no separator) when neither city nor salary is present', () => {
    const { description } = buildVacancyCardText(
      { work_type: 'other', city: null, salary_text: null },
      'ru',
    );
    expect(description).toBe('');
  });
});

describe('buildAppCardText — invite copy (LEGAL: process, not guarantee)', () => {
  it('RU copy describes the process, never an outcome/guarantee', () => {
    const { title, description } = buildAppCardText('ru');
    expect(title).toBe('Работа в Корее — вакансии для своих');
    expect(description).toBe('Вакансии в Корее, фильтруем подозрительные объявления. Бесплатно.');
    // No banned outcome/guarantee wording.
    expect(description).not.toMatch(/проверен|скам|безопас|гаранти/i);
  });
  it('EN copy describes the process, never an outcome/guarantee', () => {
    const { title, description } = buildAppCardText('en');
    expect(title).toBe('Jobs in Korea — for your own people');
    expect(description).toBe('Jobs in Korea, we filter suspicious posts. Free.');
    expect(description).not.toMatch(/scam|verified|safe|guarantee/i);
  });
});
