// lib/korea/cities/detect.test.ts
//
// Pure, DB-free coverage of the multi-city text scanner. Focus areas (owner/Sanya spec):
//   * alphabet-aware boundaries for Cyrillic / Latin (no false hits inside longer words);
//   * Hangul substring matching (no boundaries);
//   * DB-sourced aliases are ESCAPED — a regex metachar in an alias is matched literally;
//   * the Gwangju homonym: Gyeonggi context / Jeolla-Honam-metro context / no context / via hint;
//   * multi-city (3+) extraction and the empty-text no-op.

import { describe, it, expect } from 'vitest';
import { buildCityMatcher, detectCitySlugs, detectRegionSlugs, type CityAliasInput } from './detect.js';

// A representative slice of the real seed (aliases copied verbatim), plus gwangju_gyeonggi with NO
// aliases (as the seed keeps it) and a synthetic `special` city whose aliases carry regex metachars.
const CITIES: CityAliasInput[] = [
  { slug: 'seoul', aliases: ['сеул', '서울', 'seoul', 'seul'] },
  { slug: 'busan', aliases: ['пусан', 'бусан', '부산', 'busan', 'pusan'] },
  // ansan / incheon carry the Ansan-cluster landmark aliases exactly as the seed does.
  { slug: 'ansan', aliases: ['ансан', '안산', 'ansan', 'панволь', 'банволь', '반월', 'текколь', 'вонгоктон'] },
  { slug: 'incheon', aliases: ['инчхон', 'инчон', '인천', 'incheon', 'хогупхо'] },
  { slug: 'pyeongtaek', aliases: ['пхёнтхэк', 'пёнтэк', '평택', 'pyeongtaek'] },
  { slug: 'cheongju', aliases: ['чхонджу', '청주', 'cheongju'] },
  { slug: 'jeonju', aliases: ['чонджу', '전주', 'jeonju'] },
  { slug: 'gwangju', aliases: ['кванджу', '광주', 'gwangju', 'kwangju'] },
  { slug: 'gwangju_gyeonggi', aliases: [] },
  // Full-coverage additions exercised below (aliases copied verbatim from draft_seed.sql).
  { slug: 'mokpo', aliases: ['мокпхо', 'мокпо', '목포', 'mokpo'] },
  { slug: 'yesan', aliases: ['йесан', 'есан', '예산', 'yesan'] },
  { slug: 'osan', aliases: ['осан', '오산', 'osan'] },
  { slug: 'eumseong', aliases: ['ымсон', '음성', 'eumseong', 'тэсо'] },
  { slug: 'gyeongsan', aliases: ['кёнсан', '경산', 'gyeongsan'] },
  { slug: 'chuncheon', aliases: ['чхунчхон', '춘천', 'chuncheon'] },
  // Homonym members: ru surface excluded on purpose (routed through detect.ts); hangul+latin 1:1
  // except Goseong, whose 고성/goseong sit on BOTH rows.
  { slug: 'yeoncheon', aliases: ['연천', 'yeoncheon'] },
  { slug: 'yeongcheon', aliases: ['영천', 'yeongcheon'] },
  { slug: 'goseong_gangwon', aliases: ['고성', 'goseong'] },
  { slug: 'goseong_gyeongnam', aliases: ['고성', 'goseong'] },
  { slug: 'geochang', aliases: ['거창', 'geochang'] },
  { slug: 'gochang', aliases: ['고창', 'gochang'] },
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

// ── Full-coverage expansion (167 cities) ─────────────────────────────────────────────────────────

describe('spelling variants (main + alt + hangul)', () => {
  it('Mokpo matches both РУ spellings and hangul', () => {
    expect(det('Работа в Мокпхо, судоверфь')).toEqual(['mokpo']); // Kontsevich
    expect(det('город Мокпо, кафе')).toEqual(['mokpo']); // simplified
    expect(det('목포시 물류센터')).toEqual(['mokpo']); // hangul + suffix
  });
  it('Есан matches the Ё/Е systematic variant, hangul, and declines', () => {
    expect(det('📍Есан | завод')).toEqual(['yesan']); // Е- variant of Йесан
    expect(det('работа в Есане')).toEqual(['yesan']); // ...е locative
    expect(det('из Есана в Сеул')).toEqual(['seoul', 'yesan']); // ...а + multi-city
    expect(det('예산 공장 구인')).toEqual(['yesan']); // hangul
  });
  it('a bare new-city hangul is recognized (조립 suffix glued)', () => {
    expect(det('오산 조립 라인')).toEqual(['osan']);
  });
});

describe('Osan does not collide with Russian look-alikes', () => {
  it('matches Осан and its declension', () => {
    expect(det('завод в Осане, развозка')).toEqual(['osan']);
  });
  it('does NOT fire inside осанка / осанку (no such alias suffix)', () => {
    expect(det('осанка важна')).toEqual([]);
    expect(det('следите за осанкой')).toEqual([]);
  });
});

describe('province-tail guard (city-name prefix of a hyphenated province)', () => {
  it('Кёнсан-Пукто / Кёнсан-Намдо does NOT map to the city Gyeongsan', () => {
    expect(det('Локация: Сонджу, Кёнсан-Пукто')).toEqual([]);
    expect(det('объект в Кёнсан-Намдо')).toEqual([]);
  });
  it('Чхунчхон-Пукто / Чхунчхон-Намдо does NOT map to the city Chuncheon', () => {
    expect(det('провинция Чхунчхон-Намдо')).toEqual([]);
    expect(det('Чхунчхон-Пукто, женское общежитие')).toEqual([]);
  });
  it('the standalone city (and its declension) still matches', () => {
    expect(det('город Кёнсан, завод')).toEqual(['gyeongsan']);
    expect(det('в Кёнсане набор')).toEqual(['gyeongsan']);
    expect(det('Чхунчхон, Канвондо')).toEqual(['chuncheon']);
  });
});

describe('province-tail guard regression (explicit, locked)', () => {
  // Regression that was fixed but previously not pinned by a test. The province-tail guard
  // (PROVINCE_TAIL_GUARD in detect.ts) rejects a bare CITY alias that is really the prefix of a
  // hyphenated PROVINCE, but the tail must be a WHOLE token so a real district is not swallowed.
  it('«Инчхон Намдонг» → [incheon] (남동 Namdong-gu district must NOT be eaten as a namdo province tail)', () => {
    expect(det('Инчхон Намдонг, склад')).toEqual(['incheon']);
  });
  it('«Кёнсан-Намдо» → [] (province, not the city Gyeongsan)', () => {
    expect(det('Кёнсан-Намдо')).toEqual([]);
  });
  it('«город Кёнсан» → [gyeongsan] (the standalone city still matches)', () => {
    expect(det('город Кёнсан')).toEqual(['gyeongsan']);
  });
});

describe('Ansan-cluster landmark aliases', () => {
  it('local landmarks resolve to ansan / incheon / eumseong', () => {
    expect(det('ПАНВОЛЬ‼️ сборка LED')).toEqual(['ansan']);
    expect(det('развоз: Текколь, Вонгоктон')).toEqual(['ansan']);
    expect(det('반월 산업단지')).toEqual(['ansan']);
    expect(det('возле станции Хогупхо')).toEqual(['incheon']);
    expect(det('Ымсонг (Eumseong), Тэсо')).toEqual(['eumseong']);
  });
});

describe('Йончхон / Ёнчхон homonym (연천 Gyeonggi vs 영천 Gyeongbuk)', () => {
  it('bare RU surface -> BOTH cities', () => {
    expect(det('Ёнчхон, вакансия')).toEqual(['yeoncheon', 'yeongcheon']);
    expect(det('Йончхон набор')).toEqual(['yeoncheon', 'yeongcheon']);
  });
  it('Gyeonggi context -> only yeoncheon; Gyeongsang context -> only yeongcheon', () => {
    expect(det('Ёнчхон, провинция Кёнгидо')).toEqual(['yeoncheon']);
    expect(det('Йончхон, Кёнсан-Пукто')).toEqual(['yeongcheon']);
  });
  it('context can arrive via the hint', () => {
    expect(det('Ёнчхон работа', 'канал Кёнгидо')).toEqual(['yeoncheon']);
  });
  it('the DISTINCT hangul/latin stay 1:1 (never ambiguous)', () => {
    expect(det('연천군 상하차')).toEqual(['yeoncheon']);
    expect(det('영천 공장 구인')).toEqual(['yeongcheon']);
    expect(det('Yeongcheon factory')).toEqual(['yeongcheon']);
  });
});

describe('Косон homonym (고성 Gangwon vs Gyeongnam — identical hangul & latin)', () => {
  it('no context -> BOTH cities (any surface)', () => {
    expect(det('Косон, стройка')).toEqual(['goseong_gangwon', 'goseong_gyeongnam']);
    expect(det('고성 공장 구인')).toEqual(['goseong_gangwon', 'goseong_gyeongnam']);
    expect(det('Goseong warehouse')).toEqual(['goseong_gangwon', 'goseong_gyeongnam']);
  });
  it('province context narrows to one', () => {
    expect(det('Косон, Канвондо')).toEqual(['goseong_gangwon']);
    expect(det('Косон, Кёнсан-Намдо')).toEqual(['goseong_gyeongnam']);
    expect(det('고성 강원 공장')).toEqual(['goseong_gangwon']);
  });
});

describe('Кочхан homonym (거창 Gyeongnam vs 고창 Jeonbuk)', () => {
  it('bare RU surface -> BOTH; province context narrows', () => {
    expect(det('Кочхан, набор')).toEqual(['geochang', 'gochang']);
    expect(det('Кочхан, Чолла-Пукто')).toEqual(['gochang']);
    expect(det('Кочхан, Кёнсан-Намдо')).toEqual(['geochang']);
  });
  it('the DISTINCT hangul stays 1:1', () => {
    expect(det('거창 공장')).toEqual(['geochang']);
    expect(det('고창 공장')).toEqual(['gochang']);
  });
});

// ── Region (province) detection — detectRegionSlugs (regions wave) ────────────────────────────────

const reg = (text: string, hint?: string): string[] => detectRegionSlugs(text, hint).sort();

describe('detectRegionSlugs — provinces (ru / разночтения / hangul / latin)', () => {
  it('maps Russian province names + разночтения', () => {
    expect(reg('работа по всей Кёнгидо')).toEqual(['gyeonggi']);
    expect(reg('вакансии в Канвондо')).toEqual(['gangwon']);
    expect(reg('Чолла-Намдо, стройка')).toEqual(['jeonnam']);
    expect(reg('Кёнсан-Пукто завод')).toEqual(['gyeongbuk']);
    expect(reg('Чхунчхон-Намдо, ферма')).toEqual(['chungnam']);
  });
  it('maps Hangul province forms', () => {
    expect(reg('경기 지역 채용')).toEqual(['gyeonggi']);
    expect(reg('전남 물류')).toEqual(['jeonnam']);
    expect(reg('강원도 공장')).toEqual(['gangwon']);
    expect(reg('제주 호텔 구인')).toEqual(['jeju']);
  });
  it('maps Latin province forms with or without -do', () => {
    expect(reg('a job in Gyeonggi-do')).toEqual(['gyeonggi']);
    expect(reg('Chungnam factory line')).toEqual(['chungnam']);
    expect(reg('gyeongbuk hiring')).toEqual(['gyeongbuk']);
  });
  it('tolerates a Russian case ending on a province name', () => {
    expect(reg('переезд по Кёнгидо')).toEqual(['gyeonggi']);
    expect(reg('из Канвондо в Сеул').sort()).toEqual(['gangwon', 'seoul']);
  });
});

describe('detectRegionSlugs — does NOT map ambiguous bare province surfaces', () => {
  it('bare "кёнсан" / "경상" / "чолла" / "충청" (no buk/nam) resolve to no region', () => {
    expect(reg('경상 지역')).toEqual([]); // Gyeongsang without buk/nam is ambiguous
    expect(reg('где-то в Чолла')).toEqual([]); // Jeolla without buk/nam is ambiguous
    expect(reg('충청 어딘가')).toEqual([]); // Chungcheong without buk/nam is ambiguous
  });
  it('a non-place text yields nothing', () => {
    expect(reg('')).toEqual([]);
    expect(reg('обычный текст без региона')).toEqual([]);
  });
});

describe('detectRegionSlugs — gwangju metro vs Gwangju-in-Gyeonggi homonym', () => {
  it('a bare Gwangju surface -> the metro region gwangju', () => {
    expect(reg('광주광역시 채용')).toEqual(['gwangju']);
    expect(reg('работа в Кванджу')).toEqual(['gwangju']);
  });
  it('a Gyeonggi marker drops the metro gwangju (it is the Gyeonggi city -> region gyeonggi)', () => {
    expect(reg('광주 경기도 물류센터')).toEqual(['gyeonggi']);
    expect(reg('Кванджу (Кёнги)')).toEqual(['gyeonggi']);
  });
  it('Gyeonggi context via the HINT also drops the metro gwangju', () => {
    expect(reg('광주 공장 구인', '경기 지역 채널')).toEqual(['gyeonggi']);
  });
});

describe('detectRegionSlugs — does not break the city province-tail guard', () => {
  // The city scan (detectCitySlugs) must still REJECT a province tail as a city, while the region scan
  // ACCEPTS it as a region — the two are independent and never conflict (regions wave contract).
  it('«Кёнсан-Пукто»: NO city gyeongsan, YES region gyeongbuk', () => {
    expect(det('объект в Кёнсан-Пукто')).toEqual([]); // city scan rejects the province tail
    expect(reg('объект в Кёнсан-Пукто')).toEqual(['gyeongbuk']); // region scan accepts it
  });
  it('«город Кёнсан»: YES city gyeongsan, NO region (bare Gyeongsang is ambiguous)', () => {
    expect(det('город Кёнсан, завод')).toEqual(['gyeongsan']);
    expect(reg('город Кёнсан, завод')).toEqual([]);
  });
});

describe('detectRegionSlugs — metro-city regions (used by region_norm resolution)', () => {
  it('resolves a metropolitan name to its own region slug', () => {
    expect(reg('Сеул')).toEqual(['seoul']);
    expect(reg('부산 공장')).toEqual(['busan']);
    expect(reg('Тэгу')).toEqual(['daegu']);
  });
});
