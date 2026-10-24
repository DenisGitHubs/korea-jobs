// lib/korea/parser/reject-log.test.ts
//
// recordRejectBatch writes every sample in ONE insert, so one crooked sample used to cost the whole
// batch: a NUL byte (Postgres text refuses U+0000) or an Invalid Date (toISOString throws). The fake
// below behaves like Postgres on the NUL byte, so the guard is checked against the real failure mode.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const calls: { text: string; params: unknown[] }[] = [];
  const fakeSql = (strings: TemplateStringsArray, ...params: unknown[]): Promise<unknown[]> => {
    const text = (strings as unknown as string[]).join('?');
    calls.push({ text, params });
    const hasNul = params.some((p) => Array.isArray(p) && p.some((x) => typeof x === 'string' && x.includes('\u0000')));
    if (hasNul) return Promise.reject(new Error('invalid byte sequence for encoding "UTF8": 0x00'));
    return Promise.resolve([]);
  };
  return { calls, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));

import { recordRejectBatch } from './reject-log.js';

const sampleInserts = () => h.calls.filter((c) => /insert into ai_reject_samples/.test(c.text));

beforeEach(() => {
  h.calls.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('recordRejectBatch — one crooked sample never loses the batch', () => {
  it('strips NUL bytes and nulls an Invalid Date; the good sample goes in next to it', async () => {
    const good = { reason: 'shadow:o5|vacancy', confidence: 0.9, postedAt: new Date('2026-10-24T01:00:00Z'), text: 'ok', sourceNote: 'chan' };
    const bad = { reason: 'shadow:o3|error', confidence: null, postedAt: new Date('nope'), text: 'a\u0000b', sourceNote: 'c\u0000h' };

    await expect(recordRejectBatch(new Map(), [good, bad])).resolves.toBeUndefined();

    const ins = sampleInserts();
    expect(ins).toHaveLength(1);
    const [reasons, conf, posted, texts, notes] = ins[0]!.params as unknown[][];
    expect(reasons).toEqual(['shadow:o5|vacancy', 'shadow:o3|error']);
    expect(conf).toEqual([0.9, null]);
    expect(posted).toEqual(['2026-10-24T01:00:00.000Z', null]);
    expect(texts).toEqual(['ok', 'ab']);
    expect(notes).toEqual(['chan', 'ch']);
    expect(console.error).not.toHaveBeenCalled(); // the insert succeeded, nothing was swallowed
  });

  it('an unparseable posted_at string becomes null instead of failing the timestamptz cast', async () => {
    await recordRejectBatch(new Map(), [
      { reason: 'r', confidence: null, postedAt: 'garbage', text: 't', sourceNote: null },
      { reason: 'r', confidence: null, postedAt: '2026-10-24 10:00:00+00', text: 't', sourceNote: null },
    ]);
    const posted = (sampleInserts()[0]!.params as unknown[][])[2];
    expect(posted).toEqual([null, '2026-10-24T10:00:00.000Z']);
  });
});
