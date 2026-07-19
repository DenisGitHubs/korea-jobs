// lib/korea/ads/input.test.ts
//
// The shared ad-input parser is the SINGLE validate/whitelist step for both create and edit
// (an edit path that diverged here could let a changed ad skip a create-time check). Pure, no
// DB — so we can pin its exact contract: required fields, enum whitelisting, tri-state booleans,
// trim/clamp, and the identical moderation-text assembly create/edit/unarchive all rely on.

import { describe, it, expect } from 'vitest';
import { parseAdInput, adModText } from './input.js';

/** A minimal valid body (only the three required fields). */
const base = () => ({ title: 'Работник на завод', description: 'Ансан, стабильно', contact_raw: '+821012345678' });

describe('parseAdInput — required fields', () => {
  it('rejects a null body', () => {
    expect(parseAdInput(null).ok).toBe(false);
  });
  for (const missing of ['title', 'description', 'contact_raw'] as const) {
    it(`rejects when ${missing} is absent`, () => {
      const body: Record<string, unknown> = base();
      delete body[missing];
      expect(parseAdInput(body).ok).toBe(false);
    });
    it(`rejects when ${missing} is blank/whitespace`, () => {
      const body: Record<string, unknown> = { ...base(), [missing]: '   ' };
      expect(parseAdInput(body).ok).toBe(false);
    });
  }
  it('accepts the minimal valid body and trims the required fields', () => {
    const r = parseAdInput({ title: '  T  ', description: '  D  ', contact_raw: '  C  ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.title).toBe('T');
      expect(r.fields.description).toBe('D');
      expect(r.fields.contactRaw).toBe('C');
    }
  });
});

describe('parseAdInput — enum whitelisting (unknown → safe default)', () => {
  it('keeps a valid work_type, defaults an unknown one to "other"', () => {
    const ok = parseAdInput({ ...base(), work_type: 'construction' });
    const bad = parseAdInput({ ...base(), work_type: 'astronaut' });
    expect(ok.ok && ok.fields.workType).toBe('construction');
    expect(bad.ok && bad.fields.workType).toBe('other');
  });
  it('keeps a valid placement_fee, defaults an unknown one to "unknown"', () => {
    const ok = parseAdInput({ ...base(), placement_fee: 'free' });
    const bad = parseAdInput({ ...base(), placement_fee: 'later' });
    expect(ok.ok && ok.fields.placementFee).toBe('free');
    expect(bad.ok && bad.fields.placementFee).toBe('unknown');
  });
  it('keeps a valid contact_kind, nulls an unknown one', () => {
    const ok = parseAdInput({ ...base(), contact_kind: 'telegram' });
    const bad = parseAdInput({ ...base(), contact_kind: 'carrier_pigeon' });
    expect(ok.ok && ok.fields.contactKind).toBe('telegram');
    expect(bad.ok && bad.fields.contactKind).toBe(null);
  });
  it('filters invalid visa_types and de-duplicates the valid ones', () => {
    const r = parseAdInput({ ...base(), visa_types: ['e9', 'e9', 'nope', 'f4', 42] });
    expect(r.ok).toBe(true);
    if (r.ok) expect([...r.fields.visaTypes].sort()).toEqual(['e9', 'f4']);
  });
  it('returns an empty visa_types array when the field is not an array', () => {
    const r = parseAdInput({ ...base(), visa_types: 'e9' });
    expect(r.ok && r.fields.visaTypes).toEqual([]);
  });
});

describe('parseAdInput — tri-state booleans', () => {
  for (const [val, expected] of [
    [true, true],
    [false, false],
    ['true', null], // a string is NOT a boolean → null ("not stated")
    [undefined, null],
    [1, null],
  ] as const) {
    it(`has_housing ${JSON.stringify(val)} → ${JSON.stringify(expected)}`, () => {
      const r = parseAdInput({ ...base(), has_housing: val });
      expect(r.ok && r.fields.hasHousing).toBe(expected);
    });
  }
});

describe('parseAdInput — trim/clamp of free text', () => {
  it('clamps title to 120 chars and description to 4000', () => {
    const r = parseAdInput({ ...base(), title: 'x'.repeat(200), description: 'y'.repeat(5000) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.title.length).toBe(120);
      expect(r.fields.description.length).toBe(4000);
    }
  });
  it('nulls an empty optional and clamps region/city to 60', () => {
    const r = parseAdInput({ ...base(), salary_text: '   ', region_slug: 'z'.repeat(80) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.salaryText).toBe(null);
      expect(r.fields.reqRegion?.length).toBe(60);
    }
  });
});

describe('adModText — identical assembly for create/edit/unarchive', () => {
  it('joins the six parts with newlines, dropping blanks/nulls', () => {
    expect(adModText('T', 'D', null, 'sched', '', 'meals')).toBe('T\nD\nsched\nmeals');
  });
  it('is empty when every part is blank', () => {
    expect(adModText(null, null, null, null, null, null)).toBe('');
  });
});
