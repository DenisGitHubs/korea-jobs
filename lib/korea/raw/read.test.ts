// lib/korea/raw/read.test.ts
//
// GET /api/raw — the «Не проверено» (UNVERIFIED) stream behind the owner kill-switch
// config 'hide_unverified' (default FALSE = today's behaviour, nothing changes).
//
// Two things are pinned here:
//   1. flag OFF (default): the stream queries the DB and keeps its exact whitelist WHERE —
//      pending ∪ (skipped + low_confidence + non-NULL confidence), not yet a vacancy, inside the
//      freshness window, and not a copy of an already-published vacancy. A blacklist would let a
//      new reject reason leak user-visible junk, so the shape of this WHERE is a real invariant.
//   2. flag ON: an EMPTY page (200, same envelope) and NOT A SINGLE DB QUERY — the switch is
//      enforced server-side, so a stale/hacked client cannot keep reading the stream.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/db.js', () => ({ getSql: vi.fn() }));
vi.mock('../core/context.js', () => ({ authenticate: vi.fn() }));
vi.mock('../config.js', () => ({
  getConfigNumber: vi.fn(async (_k: string, fallback: number) => fallback),
  getConfigBool: vi.fn(async (_k: string, fallback: boolean) => fallback),
}));

import type { ReqLike, ResLike } from '../core/http.js';
import { getSql } from '../core/db.js';
import { authenticate } from '../core/context.js';
import { getConfigBool } from '../config.js';
import { rawFeed } from './read.js';

type Row = Record<string, unknown>;

/** rawFeed calls sql(text, params) in the FUNCTION form (not a tagged template). */
function makeSql(rows: Row[] = []) {
  const calls: { text: string; params: unknown[] }[] = [];
  const fn = (text: string, params: unknown[]): Promise<Row[]> => {
    calls.push({ text, params });
    return Promise.resolve(rows);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { fn: fn as any, calls };
}

function makeReq(method = 'GET'): ReqLike {
  return { method, headers: {}, query: {} };
}
function makeRes() {
  return {
    statusCode: 0,
    body: '',
    setHeader(_n: string, _v: string) {},
    end(b: string) {
      this.body = b;
    },
  };
}
const bodyOf = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticate).mockResolvedValue({ ok: true, user: { id: 'user-1' } } as never);
  vi.mocked(getConfigBool).mockImplementation(async (_k: string, fallback: boolean) => fallback);
});

describe('rawFeed — «Не проверено» stream + the hide_unverified kill-switch', () => {
  it('flag OFF (default): reads the DB and keeps the whitelist WHERE', async () => {
    const { fn, calls } = makeSql([
      { id: 'r1', text: 'работа на заводе, звоните 010-1111-2222', posted_at: null, fetched_at: '2026-07-25T00:00:00Z', age_days: 1 },
    ]);
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();

    await rawFeed(makeReq(), res as unknown as ResLike);

    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    const q = calls[0]!.text;
    expect(q).toContain("status = 'pending'");
    expect(q).toContain("reject_reason = 'low_confidence'");
    expect(q).toContain('confidence is not null');
    expect(q).toContain('vacancy_id is null');
    const items = bodyOf(res).items as Row[];
    expect(items).toHaveLength(1);
    expect(items[0]!.status_hint).toBe('unverified');
    expect(items[0]!.source_kind).toBe('raw');
    // The card never carries the source or a contact field (007).
    expect(Object.keys(items[0]!).sort()).toEqual(['age_hint', 'id', 'posted_at', 'source_kind', 'status_hint', 'text']);
  });

  it('flag ON: 200 with an EMPTY page and ZERO database queries', async () => {
    vi.mocked(getConfigBool).mockImplementation(async (k: string, fallback: boolean) =>
      k === 'hide_unverified' ? true : fallback,
    );
    const { fn, calls } = makeSql([{ id: 'r1', text: 'x', posted_at: null, fetched_at: '2026-07-25T00:00:00Z', age_days: 0 }]);
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();

    await rawFeed(makeReq(), res as unknown as ResLike);

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ items: [], next_cursor: null }); // same envelope -> an old client just sees an empty tab
    expect(calls).toHaveLength(0); // never touched the DB
  });

  it('401 without initData; 404 for a non-GET method', async () => {
    const { fn } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);

    const r1 = makeRes();
    await rawFeed(makeReq('POST'), r1 as unknown as ResLike);
    expect(r1.statusCode).toBe(404);

    vi.mocked(authenticate).mockResolvedValueOnce({ ok: false } as never);
    const r2 = makeRes();
    await rawFeed(makeReq(), r2 as unknown as ResLike);
    expect(r2.statusCode).toBe(401);
  });
});
