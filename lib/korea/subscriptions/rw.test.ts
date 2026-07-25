// lib/korea/subscriptions/rw.test.ts
//
// POST /api/subscription — MAILING IS OPT-IN (owner rule 2026-07-25).
//
// The one invariant these tests exist for: an ABSENT `notify` / `digest_enabled` in the body is
// stored as FALSE, never as true. The old absent-means-true reading is what produced the live bug
// where a user who turned realtime notifications OFF still got the daily digest — the client did not
// send digest_enabled at all, and the server invented `true` for it (the digest run does not consult
// `notify`, see digest/run.ts). We pin BOTH the echoed response AND the values actually bound to the
// INSERT, so an echo that lies about what was stored cannot pass.
//
// The DB is a fake tagged-template `sql`; user identity comes from a mocked authenticate() — never
// from the body (007), which is asserted too.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/db.js', () => ({ getSql: vi.fn() }));
vi.mock('../core/context.js', () => ({ authenticate: vi.fn() }));

import type { ReqLike, ResLike } from '../core/http.js';
import { getSql } from '../core/db.js';
import { authenticate } from '../core/context.js';
import { subscriptionPost } from './rw.js';

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

type Row = Record<string, unknown>;

/** Fake `sql` tagged template: cities/regions resolve to nothing, the INSERT is recorded. */
function makeSql() {
  const calls: { text: string; params: unknown[] }[] = [];
  const fn = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<Row[]> => {
    const text = Array.isArray(strings) ? (strings as unknown as string[]).join('?') : String(strings);
    calls.push({ text, params });
    return Promise.resolve([]); // no cities / no regions / insert returns nothing
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { fn: fn as any, calls };
}

function makeReq(body: unknown, method = 'POST'): ReqLike {
  return { method, headers: {}, body, query: {} };
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

/** The bound INSERT params, positionally: (user_id, city_ids, region_slugs, work_types,
 *  notify, digest_enabled, no_city, visa_types, placement_fee, require_housing, require_meals). */
function insertParams(calls: { text: string; params: unknown[] }[]): unknown[] {
  const ins = calls.find((c) => /insert into subscriptions/.test(c.text));
  expect(ins, 'the handler must have run the subscriptions INSERT').toBeTruthy();
  return ins!.params;
}
const storedNotify = (calls: { text: string; params: unknown[] }[]) => insertParams(calls)[4];
const storedDigest = (calls: { text: string; params: unknown[] }[]) => insertParams(calls)[5];
const storedNoCity = (calls: { text: string; params: unknown[] }[]) => insertParams(calls)[6];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticate).mockResolvedValue({ ok: true, user: { id: USER_ID } } as never);
});

describe('subscriptionPost — mailing is OPT-IN (absent flag = OFF)', () => {
  it('body WITHOUT notify/digest_enabled: both stored AND echoed as false', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();

    await subscriptionPost(makeReq({ city_slugs: [], work_types: [] }), res as unknown as ResLike);

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).notify).toBe(false);
    expect(bodyOf(res).digest_enabled).toBe(false);
    expect(storedNotify(calls)).toBe(false);
    expect(storedDigest(calls)).toBe(false);
  });

  it('EMPTY body (no JSON at all): still off — the absent-means-on default is gone', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();

    await subscriptionPost(makeReq(null), res as unknown as ResLike);

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).notify).toBe(false);
    expect(bodyOf(res).digest_enabled).toBe(false);
    expect(storedNotify(calls)).toBe(false);
    expect(storedDigest(calls)).toBe(false);
  });

  it('THE LIVE BUG: notify=false with digest_enabled omitted no longer opts the user into the digest', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();

    await subscriptionPost(makeReq({ notify: false }), res as unknown as ResLike);

    expect(storedNotify(calls)).toBe(false);
    expect(storedDigest(calls)).toBe(false); // was `true` before the fix -> daily digest to an opted-out user
    expect(bodyOf(res).digest_enabled).toBe(false);
  });

  it('explicit true is honoured for both flags (opt-in still works)', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();

    await subscriptionPost(makeReq({ notify: true, digest_enabled: true }), res as unknown as ResLike);

    expect(storedNotify(calls)).toBe(true);
    expect(storedDigest(calls)).toBe(true);
    expect(bodyOf(res)).toMatchObject({ notify: true, digest_enabled: true });
  });

  it('only a REAL boolean true counts: "true" / 1 are not an opt-in', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();

    await subscriptionPost(makeReq({ notify: 'true', digest_enabled: 1 }), res as unknown as ResLike);

    expect(storedNotify(calls)).toBe(false);
    expect(storedDigest(calls)).toBe(false);
  });

  it('no_city is NOT a mailing switch: absent still means true (feed/geo widening, unchanged)', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();

    await subscriptionPost(makeReq({ notify: true }), res as unknown as ResLike);

    expect(storedNoCity(calls)).toBe(true);
    expect(bodyOf(res).no_city).toBe(true);
  });

  it('the stored user id comes from initData, never from the body (007)', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();

    await subscriptionPost(
      makeReq({ user_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', notify: true }),
      res as unknown as ResLike,
    );

    expect(insertParams(calls)[0]).toBe(USER_ID);
  });

  it('401 without initData, 404 for a non-POST method — and no DB work in either case', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);

    const r1 = makeRes();
    await subscriptionPost(makeReq({}, 'GET'), r1 as unknown as ResLike);
    expect(r1.statusCode).toBe(404);

    vi.mocked(authenticate).mockResolvedValueOnce({ ok: false } as never);
    const r2 = makeRes();
    await subscriptionPost(makeReq({}), r2 as unknown as ResLike);
    expect(r2.statusCode).toBe(401);

    expect(calls).toHaveLength(0);
  });
});
