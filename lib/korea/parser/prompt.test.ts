// lib/korea/parser/prompt.test.ts
//
// Pure, DB-free coverage of readAiGeoFields — the TOLERANT reader of the conditional AI-geo fields
// (Part B) off a parsed model item. The model output is untrusted DATA: a missing key, a wrong type,
// or a malformed city_slang entry must be dropped silently (never throw), so a garbage reply can never
// break a parse. The RESOLUTION of the returned names into slugs is covered by detect.test.ts
// (detectCitySlugs / detectRegionSlugs); here we pin only the extraction/normalization contract.

import { describe, it, expect } from 'vitest';
import { readAiGeoFields } from './prompt.js';

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
