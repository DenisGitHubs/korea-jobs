// lib/korea/parser/verdict-cache.test.ts
//
// The verdict cache lets the parser reuse a prior AI reject for an EXACT repeat instead of paying the
// model again (owner rule 2026-07-21). This pins the parts that make it correct + safe:
//   * verdictHash has NO length floor (unlike parser/texthash.ts) — a SHORT repeated line must hash,
//     so one spam sentence posted 18×/hour collapses to ONE model call. It is a FUZZY letter-skeleton
//     (lowercase, keep only Cyrillic/Latin/Hangul; drop digits/emoji/punctuation/whitespace/other scripts)
//     so a copy that mimics only a digit (8000→9000) or an emoji (🐠→🏝) still shares a hash — but a
//     skeleton with NO letters at all (pure digits/emoji) returns null and is deliberately NOT cached.
//   * shouldCacheVerdict is the write-side policy — NEVER cache a vacancy, NEVER cache 'low_confidence'.
//   * lookup / touch / upsert take `sql` by injection (like streaks/update.test.ts), so we drive them
//     with a fake that captures the statement + params and returns canned rows — no DB. Best-effort:
//     a read fault yields an empty map (nothing is skipped, the batch just goes to the model).

import { describe, it, expect } from 'vitest';
import {
  verdictHash,
  shouldCacheVerdict,
  lookupVerdictCache,
  touchVerdictCache,
  upsertVerdictCache,
} from './verdict-cache.js';
import { textHash, MIN_TEXT_HASH_LEN } from './texthash.js';

type Captured = { text: string; params: unknown[] };

/** A fake tagged-template `sql` that records the statement text + bound params and returns canned rows
 *  (or throws when opts.throw is set). Mirrors the injectable-sql fakes used elsewhere in the suite. */
function fakeSql(rows: Record<string, unknown>[] = [], opts?: { throw?: boolean }) {
  const calls: Captured[] = [];
  const fn = ((strings: TemplateStringsArray | string, ...params: unknown[]) => {
    const text = Array.isArray(strings) ? (strings as unknown as string[]).join('?') : String(strings);
    calls.push({ text, params });
    if (opts?.throw) return Promise.reject(new Error('db down'));
    return Promise.resolve(rows);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return { fn, calls };
}

describe('verdictHash — fuzzy letter-skeleton (floor-less)', () => {
  it('hashes a SHORT line that the raw dedup hash deliberately ignores', () => {
    const short = 'работа есть'; // well under MIN_TEXT_HASH_LEN
    expect(short.length).toBeLessThan(MIN_TEXT_HASH_LEN);
    expect(textHash(short)).toBeNull(); // raw dedup contour: too short -> not deduped
    const h = verdictHash(short);
    expect(h).not.toBeNull();
    expect(h).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it('collapses whitespace / zero-width / case so trivially-different copies share a hash', () => {
    const a = 'Возьму пару человек на вакансию';
    // b differs only by case, extra/tabbed whitespace, surrounding blanks, and a zero-width space
    // (the skeleton keeps only letters, so all of that vanishes regardless).
    const b = '  возьму   пару человек​\tна   вакансию  \n';
    expect(verdictHash(a)).toBe(verdictHash(b));
  });

  it('collapses a DIGIT-only mimic (8000→9000) onto the same family', () => {
    expect(verdictHash('Оплата 8000 вон за смену')).toBe(verdictHash('Оплата 9000 вон за смену'));
  });

  it('collapses an EMOJI / punctuation mimic (🐠→🏝) onto the same family', () => {
    expect(verdictHash('Срочно 🐠 работа есть')).toBe(verdictHash('Срочно🏝, работа есть!!!'));
  });

  it('drops non-whitelisted scripts (Greek/CJK look-alikes) — only Cyrillic/Latin/Hangul survive', () => {
    expect(verdictHash('αβγ')).toBeNull(); // pure Greek -> empty skeleton -> null
    expect(verdictHash('αβγработа')).toBe(verdictHash('работа')); // Greek decoration stripped off
  });

  it('keeps Hangul letters in the skeleton', () => {
    expect(verdictHash('서울 알바')).not.toBeNull();
    expect(verdictHash('서울 알바')).not.toBe(verdictHash('부산 알바'));
  });

  it('gives DIFFERENT letter-skeletons DIFFERENT hashes (no accidental collision)', () => {
    expect(verdictHash('халтурка сегодня')).not.toBe(verdictHash('халтурка завтра'));
  });

  it('returns null for empty / whitespace-only text (nothing to key on)', () => {
    expect(verdictHash('')).toBeNull();
    expect(verdictHash(null)).toBeNull();
    expect(verdictHash(undefined)).toBeNull();
    expect(verdictHash('   \n\t ​ ')).toBeNull();
  });

  it('returns null for a letter-LESS skeleton (pure digits / emoji / phone) — NOT cached', () => {
    expect(verdictHash('8000 9000')).toBeNull();
    expect(verdictHash('💋')).toBeNull();
    expect(verdictHash('💞🔞')).toBeNull();
    expect(verdictHash('01072771369')).toBeNull();
    expect(verdictHash('🐠→🏝')).toBeNull();
  });
});

describe('shouldCacheVerdict — never cache a vacancy or low_confidence', () => {
  it('caches a genuine non-vacancy reject', () => {
    expect(shouldCacheVerdict(false, 'spam')).toBe(true);
    expect(shouldCacheVerdict(false, 'unclear')).toBe(true);
    expect(shouldCacheVerdict(false, 'chitchat')).toBe(true);
    expect(shouldCacheVerdict(false, 'not_vacancy')).toBe(true);
  });
  it('NEVER caches a vacancy (rides the normal dedup contour)', () => {
    expect(shouldCacheVerdict(true, 'low_confidence')).toBe(false);
    expect(shouldCacheVerdict(true, 'spam')).toBe(false); // defensive: even a mislabelled vacancy
  });
  it("NEVER caches 'low_confidence' (the visible «Не проверено» tab)", () => {
    expect(shouldCacheVerdict(false, 'low_confidence')).toBe(false);
  });
});

describe('lookupVerdictCache — one select, best-effort', () => {
  it('maps hits hash -> reject_reason from the returned rows', async () => {
    const { fn, calls } = fakeSql([
      { text_hash: 'h1', reject_reason: 'spam' },
      { text_hash: 'h2', reject_reason: 'chitchat' },
    ]);
    const map = await lookupVerdictCache(fn, ['h1', 'h2', 'h3']);
    expect(map.get('h1')).toBe('spam');
    expect(map.get('h2')).toBe('chitchat');
    expect(map.has('h3')).toBe(false); // no row came back for it
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('ai_verdict_cache');
    expect(calls[0]!.params[0]).toEqual(['h1', 'h2', 'h3']); // bound array, never interpolated
  });

  it('short-circuits on an empty hash list (no query at all)', async () => {
    const { fn, calls } = fakeSql([{ text_hash: 'x', reject_reason: 'spam' }]);
    const map = await lookupVerdictCache(fn, []);
    expect(map.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('returns an EMPTY map on a read fault (nothing skipped — batch falls through to the model)', async () => {
    const { fn } = fakeSql([], { throw: true });
    const map = await lookupVerdictCache(fn, ['h1']);
    expect(map.size).toBe(0);
  });
});

describe('touchVerdictCache — bump n / last_seen for served hashes', () => {
  it('issues an additive update bound to the distinct hashes', async () => {
    const { fn, calls } = fakeSql([]);
    await touchVerdictCache(fn, ['h1', 'h2']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('n = n + 1');
    expect(calls[0]!.text).toContain('last_seen = now()');
    expect(calls[0]!.params[0]).toEqual(['h1', 'h2']);
  });
  it('does nothing for an empty list', async () => {
    const { fn, calls } = fakeSql([]);
    await touchVerdictCache(fn, []);
    expect(calls).toHaveLength(0);
  });
  it('swallows a write fault (best-effort)', async () => {
    const { fn } = fakeSql([], { throw: true });
    await expect(touchVerdictCache(fn, ['h1'])).resolves.toBeUndefined();
  });
});

describe('upsertVerdictCache — remember a fresh reject', () => {
  it('inserts on the primary key and bumps on conflict, binding hash + reason', async () => {
    const { fn, calls } = fakeSql([]);
    await upsertVerdictCache(fn, 'h1', 'unclear');
    expect(calls).toHaveLength(1);
    const { text, params } = calls[0]!;
    expect(text).toContain('insert into ai_verdict_cache');
    expect(text).toContain('on conflict (text_hash) do update');
    expect(params[0]).toBe('h1');
    expect(params[1]).toBe('unclear');
  });
  it('swallows a write fault (best-effort)', async () => {
    const { fn } = fakeSql([], { throw: true });
    await expect(upsertVerdictCache(fn, 'h1', 'spam')).resolves.toBeUndefined();
  });
});

describe('verdictHash — phone marker splits the family (owner risk-review 21.07)', () => {
  it('same text with an added Korean mobile is a DIFFERENT cache key', () => {
    const bare = verdictHash('Арбайт на завод, сегодня в ночь');
    const withPhone = verdictHash('Арбайт на завод, сегодня в ночь 010-9002-3848');
    expect(bare).not.toBeNull();
    expect(withPhone).not.toBeNull();
    expect(withPhone).not.toBe(bare);
  });
  it('+82 international run also flips the key', () => {
    expect(verdictHash('Звоните +82 10-1234-5678, работа')).not.toBe(verdictHash('Звоните, работа'));
  });
  it('salary runs do NOT flip the key (not a phone)', () => {
    expect(verdictHash('Зарплата 2 500 000 вон, завод')).toBe(verdictHash('Зарплата 2500000 вон завод'));
  });
  it('a pure-phone message still has no skeleton -> not cached', () => {
    expect(verdictHash('010-7277-1369')).toBeNull();
  });
});
