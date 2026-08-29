// lib/korea/parser/prompt.test.ts
//
// Pure, DB-free coverage of readAiGeoFields — the TOLERANT reader of the conditional AI-geo fields
// (Part B) off a parsed model item. The model output is untrusted DATA: a missing key, a wrong type,
// or a malformed city_slang entry must be dropped silently (never throw), so a garbage reply can never
// break a parse. The RESOLUTION of the returned names into slugs is covered by detect.test.ts
// (detectCitySlugs / detectRegionSlugs); here we pin only the extraction/normalization contract.

import { describe, it, expect } from 'vitest';
import { readAiGeoFields, buildSystemPrompt, REJECT_REASONS, type CityRef } from './prompt.js';

describe('readAiGeoFields — happy path', () => {
  it('extracts city_norm, region_norm and city_slang pairs, trimmed', () => {
    const it_ = {
      id: '3',
      is_vacancy: true,
      city_norm: '  Соннам  ',
      region_norm: 'Кёнгидо',
      city_slang: [
        { slang: '미금', norm: 'Соннам' },
        { slang: '  판교 ', norm: ' Соннам ' },
      ],
    };
    const g = readAiGeoFields(it_);
    expect(g.cityNorm).toBe('Соннам');
    expect(g.regionNorm).toBe('Кёнгидо');
    expect(g.slang).toEqual([
      { slang: '미금', norm: 'Соннам' },
      { slang: '판교', norm: 'Соннам' },
    ]);
  });
});

describe('readAiGeoFields — tolerant of missing / wrong-typed keys', () => {
  it('returns nulls + empty slang for an item with none of the keys', () => {
    expect(readAiGeoFields({ id: '0', is_vacancy: false })).toEqual({ cityNorm: null, regionNorm: null, slang: [] });
  });
  it('drops non-string city_norm / region_norm', () => {
    const g = readAiGeoFields({ city_norm: 42, region_norm: { x: 1 } });
    expect(g.cityNorm).toBeNull();
    expect(g.regionNorm).toBeNull();
  });
  it('treats an empty / whitespace-only string as null', () => {
    const g = readAiGeoFields({ city_norm: '   ', region_norm: '' });
    expect(g.cityNorm).toBeNull();
    expect(g.regionNorm).toBeNull();
  });
  it('ignores a non-array city_slang', () => {
    expect(readAiGeoFields({ city_slang: 'nope' }).slang).toEqual([]);
    expect(readAiGeoFields({ city_slang: { slang: 'x', norm: 'y' } }).slang).toEqual([]);
  });
  it('drops malformed slang entries but keeps the good ones', () => {
    const g = readAiGeoFields({
      city_slang: [
        null,
        'string-not-object',
        { norm: 'Соннам' }, // no slang surface -> useless -> dropped
        { slang: '', norm: 'Соннам' }, // empty surface -> dropped
        { slang: '미금' }, // missing norm -> kept with norm=''
        { slang: '구디', norm: 5 }, // non-string norm -> kept with norm=''
      ],
    });
    expect(g.slang).toEqual([
      { slang: '미금', norm: '' },
      { slang: '구디', norm: '' },
    ]);
  });
  it('never throws on a completely unexpected shape', () => {
    expect(() => readAiGeoFields(null)).not.toThrow();
    expect(() => readAiGeoFields(undefined)).not.toThrow();
    expect(() => readAiGeoFields('a string')).not.toThrow();
    expect(readAiGeoFields(null)).toEqual({ cityNorm: null, regionNorm: null, slang: [] });
  });
});

// --- criminal_hiring (2026-08-19). The deterministic filters cut the KNOWN wordings before the model;
// this reason is what lets the model reject a wording no pattern anticipated. A mule recruiter is
// literally "an employer looking for workers", so without an explicit rule the contract's own
// is_vacancy=true definition invites the model to publish him.
describe('criminal_hiring reject reason', () => {
  const CITIES: CityRef[] = [
    { slug: 'ansan', name: { ru: 'Ансан', ko: '안산', en: 'Ansan' }, region_slug: 'gyeonggi' },
  ];
  const REGIONS = ['gyeonggi'];

  it('is part of the model-facing enum', () => {
    expect(REJECT_REASONS).toContain('criminal_hiring');
  });

  it('the prompt names the reason AND the vocabulary that triggers it', () => {
    const p = buildSystemPrompt(CITIES, REGIONS);
    expect(p).toContain('criminal_hiring');
    expect(p).toContain('обнал');
    expect(p).toContain('дропы');
    expect(p).toContain('аренда карт');
    // The enum line of OUTPUT FORMAT is generated from REJECT_REASONS, so the model sees the value
    // as an allowed output, not only as prose.
    expect(p).toContain('reject_reason is one of:');
  });

  // COUNTERWEIGHT (2026-08-29). The trigger list contains "клад" and "работа за %", and the three
  // most common HOMONYMS of those on this board are ordinary mass-market jobs: a warehouse worker,
  // a bricklayer, and anyone paid a share of takings. No deterministic filter knows these words
  // (spamfilter.ts / adspam.ts contain neither "клад" nor "процент"), so the prompt is the only
  // place that can hold them apart.
  //
  // WHY THIS IS A SENTINEL AND NOT A NICETY: verdict-cache.ts caches EVERY reject, keyed on a
  // letters-only skeleton of the text (digits, emoji and punctuation stripped). One wrong reject on
  // "Требуется кладовщик, 2 500 000 вон" therefore blocks the WHOLE family of that posting — any
  // wage, any date, for ever, without asking the model again. The vacancy then disappears in a way
  // that looks exactly like the filter working correctly.
  it('holds the innocent homonyms of the trigger words apart from crime', () => {
    const p = buildSystemPrompt(CITIES, REGIONS);
    for (const word of ['кладовщик', 'работа на складе', 'кладка', 'каменщик', 'закладка фундамента']) {
      expect(p, word).toContain(word);
    }
    for (const word of ['процент от выручки', 'процент с продаж']) {
      expect(p, word).toContain(word);
    }
    // The counterweight has to say WHICH way to classify them, not merely mention the words.
    expect(p).toContain('LOOK-ALIKE WORDS ARE NOT CRIME');
    // ...and it must stand AFTER the trigger list, so the model reads the exception last.
    expect(p.indexOf('LOOK-ALIKE WORDS ARE NOT CRIME')).toBeGreaterThan(p.indexOf('"клад"'));
  });

  // PROMPT-CACHE ORDER (Skills\Рома\ai-cost-haiku-korea-jobs.md): the cacheable text must sit BEFORE
  // the volatile part of the prompt. The city list is the volatile part (it changes when cities are
  // added), so a static instruction added AFTER it would move on every city change and cost cache
  // hits. This pins the instruction ahead of the city list.
  it('sits BEFORE the volatile city list (cache prefix stays stable)', () => {
    const p = buildSystemPrompt(CITIES, REGIONS);
    expect(p.indexOf('criminal_hiring')).toBeGreaterThan(-1);
    expect(p.indexOf('criminal_hiring')).toBeLessThan(p.indexOf('ansan = Ансан'));
  });
});
