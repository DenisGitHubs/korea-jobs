// lib/korea/cities/detect.test.ts
//
// Pure, DB-free coverage of the multi-city text scanner. Focus areas (owner/Sanya spec):
//   * alphabet-aware boundaries for Cyrillic / Latin (no false hits inside longer words);
//   * Hangul substring matching (no boundaries);
//   * DB-sourced aliases are ESCAPED — a regex metachar in an alias is matched literally;
//   * the Gwangju homonym: Gyeonggi context / Jeolla-Honam-metro context / no context / via hint;
//   * multi-city (3+) extraction and the empty-text no-op.

import { describe, it, expect } from 'vitest';
import { buildCityMatcher, detectCitySlugs, type CityAliasInput } from './detect.js';

// A representative slice of the real seed (aliases copied verbatim), plus gwangju_gyeonggi with NO
// aliases (as the seed keeps it) and a synthetic `special` city whose aliases carry regex metachars.
const CITIES: CityAliasInput[] = [
  { slug: 'seoul', aliases: ['сеул', '서울', 'seoul', 'seul'] },
  { slug: 'busan', aliases: ['пусан', 'бусан', '부산', 'busan', 'pusan'] },
  { slug: 'ansan', aliases: ['ансан', '안산', 'ansan'] },
  { slug: 'incheon', aliases: ['инчхон', 'инчон', '인천', 'incheon'] },
  { slug: 'pyeongtaek', aliases: ['пхёнтхэк', 'пёнтэк', '평택', 'pyeongtaek'] },
  { slug: 'cheongju', aliases: ['чхонджу', '청주', 'cheongju'] },
  { slug: 'jeonju', aliases: ['чонджу', '전주', 'jeonju'] },
  { slug: 'gwangju', aliases: ['кванджу', '광주', 'gwangju', 'kwangju'] },
  { slug: 'gwangju_gyeonggi', aliases: [] },
  { slug: 'special', aliases: ['a.b', 'c+d'] },
];

const matcher = buildCityMatcher(CITIES);
const det = (text: string, hint?: string): string[] =>
  detectCitySlugs(text, matcher, hint === undefined ? undefined : { hintText: hint }).sort();

const ZWSP = String.fromCharCode(0x200b); // zero-width space, constructed (no literal invisible in source)

describe('Cyrillic boundaries', () => {
  it('matches a standalone Cyrillic city name (any case, any punctuation)', () => {
    expect(det('Работа: Ансан, завод автозапчастей')).toEqual(['ansan']);
    expect(det('ПУСАН — вакансии на заводе')).toEqual(['busan']);
    expect(det('вакансии (Сеул) сегодня')).toEqual(['seoul']);
  });
  it('does NOT match a city name embedded in a longer word', () => {
    expect(det('трансансанский комбинат')).toEqual([]); // "ансан" glued inside a word -> no hit
    expect(det('пусантик')).toEqual([]); // trailing letters break the right boundary
  });
  it('DOES match a Russian declension (closed-list case ending а|у|е|ом before the boundary)', () => {
    // Owner/orchestrator-approved contract change: aliases are seeded nominative, but ads decline
    // them. A Cyrillic alias now tolerates ONE optional case ending from the closed list before the
    // right boundary — these are the most common forms in Russian posts.
    expect(det('работа в ансане')).toEqual(['ansan']); // ...е
    expect(det('из ансана')).toEqual(['ansan']); // ...а
    expect(det('ансаном')).toEqual(['ansan']); // ...ом
    expect(det('в сеуле')).toEqual(['seoul']); // ...е
    expect(det('работа в Ансане и в Сеуле')).toEqual(['ansan', 'seoul']); // multi, mixed case
  });
  it('does NOT match an ending OUTSIDE the closed list (must be exactly а|у|е|ом)', () => {
    expect(det('осанка')).toEqual([]); // no alias inside; suffix logic must not over-reach
    expect(det('осанку')).toEqual([]); // trailing "у" is a case suffix, but there is no alias
    expect(det('пусанский завод')).toEqual([]); // "пусан" + "ский": "ский" not in the list -> boundary fails
  });
});

describe('Latin boundaries', () => {
  it('matches a standalone Latin city name', () => {
    expect(det('a job in Busan, factory line')).toEqual(['busan']);
  });
  it('does NOT match inside a longer Latin token', () => {
    expect(det('Busanalytics Ltd is hiring')).toEqual([]);
    expect(det('preseoulized')).toEqual([]);
  });
});

describe('Hangul is a boundary-free substring match', () => {
  it('matches the bare syllables', () => {
    expect(det('서울 공장 모집')).toEqual(['seoul']);
  });
  it('matches even when glued to a suffix (서울시)', () => {
    expect(det('서울시 물류센터 상하차')).toEqual(['seoul']);
  });
  it('strips a zero-width char wedged inside the syllables', () => {
    expect(det('서' + ZWSP + '울 공장')).toEqual(['seoul']); // ZWSP removed by normalization
  });
});

describe('DB-sourced aliases are escaped (metachars are literal)', () => {
  it('matches the literal dotted alias but not a wildcard expansion', () => {
    expect(det('office at a.b street')).toEqual(['special']);
    expect(det('code aXb is not a city')).toEqual([]); // '.' must be literal, not "any char"
  });
  it('matches the literal plus alias but not a "+"-quantifier expansion', () => {
    expect(det('the c+d block')).toEqual(['special']);
    expect(det('cccd is not a match')).toEqual([]); // '+' must be literal, not "one or more c"
  });
});

describe('cheongju / jeonju stay 1:1 (never conflated)', () => {
  it('resolves the Hangul forms distinctly', () => {
    expect(det('청주 공장')).toEqual(['cheongju']);
    expect(det('전주 식당 구인')).toEqual(['jeonju']);
  });
  it('resolves the Russian forms per the seed aliases', () => {
    expect(det('Чонджу, завод')).toEqual(['jeonju']);
    expect(det('Чхонджу, стройка')).toEqual(['cheongju']);
  });
});

describe('Gwangju homonym', () => {
  it('Gyeonggi context -> only gwangju_gyeonggi', () => {
    expect(det('광주 경기도 물류센터 상하차 구인')).toEqual(['gwangju_gyeonggi']);
    expect(det('Gwangju (Gyeonggi) warehouse job')).toEqual(['gwangju_gyeonggi']);
  });
  it('Jeolla / Honam / metropolitan context -> only the metro gwangju', () => {
    expect(det('광주광역시 전라 공장')).toEqual(['gwangju']);
    expect(det('광주 호남 지역 채용')).toEqual(['gwangju']);
  });
  it('no context -> BOTH cities (completeness over precision)', () => {
    expect(det('광주 공장 구인')).toEqual(['gwangju', 'gwangju_gyeonggi']);
    expect(det('работа в Кванджу')).toEqual(['gwangju', 'gwangju_gyeonggi']);
  });
  it('conflicting context (both markers) -> BOTH cities', () => {
    expect(det('광주 경기 그리고 전라 언급')).toEqual(['gwangju', 'gwangju_gyeonggi']);
  });
  it('Gyeonggi context supplied via the hint disambiguates to gwangju_gyeonggi', () => {
    expect(det('광주 공장 구인', '경기 지역 채용 채널')).toEqual(['gwangju_gyeonggi']);
  });
});

describe('multi-city and empty input', () => {
  it('extracts 3+ cities from one message, de-duplicated and mixed scripts', () => {
    expect(det('Работа: 서울, Busan, Ансан — набор')).toEqual(['ansan', 'busan', 'seoul']);
  });
  it('collapses a city named twice into one slug', () => {
    expect(det('Ансан завод, снова Ансан общежитие')).toEqual(['ansan']);
  });
  it('returns nothing for empty / whitespace / no-city text', () => {
    expect(det('')).toEqual([]);
    expect(det('   \n  ')).toEqual([]);
    expect(det('обычный текст без города')).toEqual([]);
  });
});
