// lib/korea/raw/reveal.test.ts
//
// rawReveal (POST /api/raw/reveal) reveals the ORIGINAL text of ONE UNVERIFIED raw message under the
// SAME shared daily reveal cap as the vacancy/ad contact reveal (reveals24h, counted across all three
// audit tables — see vacancies/read.test.ts for the summed SQL). Here we drive the handler through
// mocked getSql / authenticate / config and a mocked reveals24h so we can pin its control flow on a
// fake DB: first reveal charges the budget + records with an on-conflict guard; a repeat is free (no
// budget read, no insert); hitting the cap → 429 with no insert; a row outside the whitelist → 404.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/db.js', () => ({ getSql: vi.fn() }));
vi.mock('../core/context.js', () => ({ authenticate: vi.fn() }));
vi.mock('../config.js', () => ({
  getConfigNumber: vi.fn(async (_k: string, fallback: number) => fallback),
}));
// reveals24h IS the shared budget. Mock it so this suite controls the cap gate directly; its 3-table
// SQL is characterized in vacancies/read.test.ts.
vi.mock('../vacancies/read.js', () => ({ reveals24h: vi.fn() }));

import type { ReqLike, ResLike } from '../core/http.js';
import { getSql } from '../core/db.js';
import { authenticate } from '../core/context.js';
import { reveals24h } from '../vacancies/read.js';
import { rawReveal } from './reveal.js';

const RID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

type Row = Record<string, unknown>;
interface FakeOpts {
  rawRow?: Row | null;
  alreadyRevealed?: boolean;
}

function makeSql(opts: FakeOpts = {}) {
  const calls: { text: string; params: unknown[] }[] = [];
  const alreadyRows: Row[] = opts.alreadyRevealed ? [{ one: 1 }] : [];
  const fn = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<Row[]> => {
    const text = Array.isArray(strings) ? (strings as unknown as string[]).join('?') : String(strings);
    calls.push({ text, params });
    if (/from raw_messages/.test(text)) return Promise.resolve(opts.rawRow ? [opts.rawRow] : []);
    if (/select 1\s+from raw_contact_reveals/.test(text)) return Promise.resolve(alreadyRows);
    return Promise.resolve([]); // insert + else
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { fn: fn as any, calls };
}

function makeReq(body: unknown, method = 'POST'): ReqLike {
  return { method, headers: {}, body, query: {} };
}
function makeRes() {
  const res = {
    statusCode: 0,
    body: '',
    setHeader(_n: string, _v: string) {},
    end(b: string) {
      this.body = b;
    },
  };
  return res;
}
const bodyOf = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

beforeEach(() => {
  // Clear accumulated call history (vitest does not auto-reset between tests), then re-arm the
  // default behaviors — otherwise `.not.toHaveBeenCalled()` would see a prior test's reveals24h call.
  vi.clearAllMocks();
  vi.mocked(authenticate).mockResolvedValue({ ok: true, user: { id: 'user-1' } } as never);
  vi.mocked(reveals24h).mockResolvedValue(0);
});

describe('rawReveal — shared daily cap, free repeat, race-safe insert', () => {
  it('first reveal under the cap: 200 + original text, charges the shared budget, records with an on-conflict guard', async () => {
    const { fn, calls } = makeSql({ rawRow: { id: RID, text: 'звоните 010-1111-2222' } });
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();
    await rawReveal(makeReq({ raw_id: RID }), res as unknown as ResLike);

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ id: RID, text: 'звоните 010-1111-2222' });
    // shared budget consulted with the fake sql + the authenticated id (never the body id)
    expect(vi.mocked(reveals24h)).toHaveBeenCalledWith(fn, 'user-1');
    const insert = calls.find((c) => /insert into raw_contact_reveals/.test(c.text));
    expect(insert).toBeTruthy();
    expect(insert!.text).toContain('on conflict (user_id, raw_id) do nothing');
  });

  it('repeat reveal is FREE: budget never read, nothing inserted', async () => {
    const { fn, calls } = makeSql({ rawRow: { id: RID, text: 't' }, alreadyRevealed: true });
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();
    await rawReveal(makeReq({ raw_id: RID }), res as unknown as ResLike);

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(reveals24h)).not.toHaveBeenCalled();
    expect(calls.some((c) => /insert into raw_contact_reveals/.test(c.text))).toBe(false);
  });

  it('at the cap: 429 rate_limited and NO reveal recorded', async () => {
    vi.mocked(reveals24h).mockResolvedValue(50); // == default cap
    const { fn, calls } = makeSql({ rawRow: { id: RID, text: 't' } });
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();
    await rawReveal(makeReq({ raw_id: RID }), res as unknown as ResLike);

    expect(res.statusCode).toBe(429);
    expect(calls.some((c) => /insert into raw_contact_reveals/.test(c.text))).toBe(false);
  });

  it('404 when the row is not in the UNVERIFIED whitelist (foreign / already a vacancy / aged out)', async () => {
    const { fn } = makeSql({ rawRow: null });
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();
    await rawReveal(makeReq({ raw_id: RID }), res as unknown as ResLike);
    expect(res.statusCode).toBe(404);
  });

  it('CHARACTERIZATION: a null stored text coalesces to an empty string', async () => {
    const { fn } = makeSql({ rawRow: { id: RID, text: null } });
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();
    await rawReveal(makeReq({ raw_id: RID }), res as unknown as ResLike);
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ id: RID, text: '' });
  });

  it('CHARACTERIZATION: a missing/invalid raw_id is 400 bad_request (vacancyContact uses 404 instead)', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);

    const r1 = makeRes();
    await rawReveal(makeReq({}), r1 as unknown as ResLike); // no raw_id
    expect(r1.statusCode).toBe(400);

    const r2 = makeRes();
    await rawReveal(makeReq({ raw_id: 'not-a-uuid' }), r2 as unknown as ResLike);
    expect(r2.statusCode).toBe(400);

    expect(calls).toHaveLength(0); // never reached the DB
  });

  it('404 for a non-POST method', async () => {
    const res = makeRes();
    await rawReveal(makeReq({ raw_id: RID }, 'GET'), res as unknown as ResLike);
    expect(res.statusCode).toBe(404);
  });

  it('401 when initData does not authenticate', async () => {
    vi.mocked(authenticate).mockResolvedValueOnce({ ok: false } as never);
    const res = makeRes();
    await rawReveal(makeReq({ raw_id: RID }), res as unknown as ResLike);
    expect(res.statusCode).toBe(401);
  });
});
