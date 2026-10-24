// lib/korea/cleanup/run.test.ts
//
// The reject-sample retention clock (owner decision 2026-10-24): ai_reject_samples rows of the SHADOW
// rules (reject_reason 'shadow:%' — parser/reject-log.ts) live 10 days, every other sample 7 days, and
// both clocks sit in ONE delete. The database is faked (queries recorded by text); the statement is
// checked as written, so this pins the SQL, not a live run.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = { calls: [] as string[], failSamples: false };
  const fakeSql = (strings: TemplateStringsArray | string): Promise<unknown[]> => {
    const text = (typeof strings === 'string' ? strings : strings.join(' ? ')).replace(/\s+/g, ' ').trim();
    state.calls.push(text);
    if (state.failSamples && text.includes('delete from ai_reject_samples')) {
      return Promise.reject(new Error('relation "ai_reject_samples" does not exist'));
    }
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('../config.js', () => ({ getConfigNumber: async (_k: string, fb: number) => fb }));
vi.mock('./inactive.js', () => ({ runInactiveErase: async () => ({ usersErased: 0 }) }));
vi.mock('../scheduled/run.js', () => ({ runScheduledPosts: async () => ({ published: 0 }) }));

import { runCleanup } from './run.js';

beforeEach(() => {
  h.state.calls = [];
  h.state.failSamples = false;
});

describe('runCleanup — reject samples: shadow 10 days, the rest 7, one statement', () => {
  it('purges with a single delete that carries both clocks', async () => {
    await runCleanup();
    const deletes = h.state.calls.filter((t) => t.includes('delete from ai_reject_samples'));
    expect(deletes).toHaveLength(1);
    const q = deletes[0]!;
    expect(q).toContain("case when reject_reason like 'shadow:%' then interval '10 days' else interval '7 days' end");
    expect(q).toMatch(/where rejected_at < now\(\) - case/);
  });

  it('a missing samples table does not stop the other steps', async () => {
    h.state.failSamples = true;
    const r = await runCleanup();
    expect(r.rejectSamplesPurged).toBe(0);
    expect(h.state.calls.some((t) => t.includes('delete from ai_verdict_cache'))).toBe(true);
  });
});
