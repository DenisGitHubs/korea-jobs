// lib/korea/parser/run.test.ts
//
// Pins the DEFENSE-IN-DEPTH invariant behind the «Не проверено» tab (Censor «остаток-3»).
//
// The «первая судимая ИИ копия» discriminator is: an AI-JUDGED reject/low_confidence row carries a
// NON-NULL raw_messages.confidence, while a pre-AI cache-skip (verdict-cache replay) writes NO
// confidence and leaves it NULL. raw/read.ts, admin/stats.ts and raw/reveal.ts all key the visible
// low_confidence arm on `confidence IS NOT NULL`, so the first (judged) copy shows and cached repeats
// are hidden. That whole scheme silently breaks if the model ever returns is_vacancy=true with
// low_confidence but OMITS the confidence number — the naive `it.confidence ?? null` would then write
// NULL and the judged row would be indistinguishable from a cache-skip and vanish from the tab.
//
// aiJudgedConfidence() is the write-path guard that closes that hole: any AI-judged row gets a
// non-NULL confidence (a missing/non-finite value defaults to 0, still under parser_min_confidence).

import { describe, it, expect } from 'vitest';
import { aiJudgedConfidence } from './run.js';

describe('aiJudgedConfidence — an AI-judged row is NEVER written with a NULL confidence', () => {
  it('passes a finite number through unchanged (incl. 0 and sub-threshold values)', () => {
    expect(aiJudgedConfidence(0.4)).toBe(0.4);
    expect(aiJudgedConfidence(0.59)).toBe(0.59);
    expect(aiJudgedConfidence(0)).toBe(0);
    expect(aiJudgedConfidence(1)).toBe(1);
  });

  it('defaults a MISSING confidence (model omitted the field) to 0 — never NULL/undefined', () => {
    expect(aiJudgedConfidence(undefined)).toBe(0);
    expect(aiJudgedConfidence(null)).toBe(0);
  });

  it('defaults a non-finite / wrong-typed confidence to 0 (defense in depth)', () => {
    expect(aiJudgedConfidence(NaN)).toBe(0);
    expect(aiJudgedConfidence(Infinity)).toBe(0);
    expect(aiJudgedConfidence('0.5')).toBe(0);
    expect(aiJudgedConfidence({})).toBe(0);
  });

  it('the result is ALWAYS a real number (so the DB write is never NULL)', () => {
    for (const v of [undefined, null, NaN, 'x', {}, [], 0.42, 0]) {
      const c = aiJudgedConfidence(v);
      expect(typeof c).toBe('number');
      expect(Number.isFinite(c)).toBe(true);
      expect(c).not.toBeNull();
    }
  });
});

describe('«Не проверено» visibility — AI-judged low_confidence shows, cache-skip is hidden', () => {
  // Mirror of the read-side whitelist arm for a skipped row: raw/read.ts (~135), admin/stats.ts
  // (~105) and raw/reveal.ts (~66) all show a low_confidence row ONLY when confidence IS NOT NULL.
  const shownInUnverified = (row: {
    status: string;
    reject_reason: string | null;
    confidence: number | null;
  }): boolean =>
    row.status === 'skipped' &&
    row.reject_reason === 'low_confidence' &&
    row.confidence !== null;

  it('a low_confidence row the model judged but WITHOUT a confidence still shows (confidence→0)', () => {
    // Model reply: is_vacancy true, low confidence, but the confidence NUMBER is missing.
    const modelItem: { is_vacancy: boolean; confidence?: number } = { is_vacancy: true };
    const row = {
      status: 'skipped',
      reject_reason: 'low_confidence',
      confidence: aiJudgedConfidence(modelItem.confidence), // == the run.ts write path
    };
    expect(row.confidence).not.toBeNull();
    expect(row.confidence).toBe(0);
    expect(shownInUnverified(row)).toBe(true); // the AI-judged first copy is VISIBLE
  });

  it('a pre-AI cache-skip (confidence left NULL) stays HIDDEN — the discriminator holds', () => {
    // verdict-cache replay writes reject_reason='low_confidence' but NO confidence column → NULL.
    const cacheSkipRow = { status: 'skipped', reject_reason: 'low_confidence', confidence: null };
    expect(shownInUnverified(cacheSkipRow)).toBe(false);
  });

  it('a low_confidence row WITH a real model confidence shows as before (no regression)', () => {
    const row = {
      status: 'skipped',
      reject_reason: 'low_confidence',
      confidence: aiJudgedConfidence(0.45),
    };
    expect(row.confidence).toBe(0.45);
    expect(shownInUnverified(row)).toBe(true);
  });
});
