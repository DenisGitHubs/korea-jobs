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
import { isOverDailyCap } from '../notify/cap.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// notify_daily_cap (owner, 2026-07-26) — "сколько уведомлений в сутки".
//
// Owner's rule: EVERYONE is unlimited unless they picked a number themselves — there is no default
// limit anywhere (no column DEFAULT, no constant). A brand-new row is therefore created with NULL.
//
// This endpoint REPLACES the whole subscription row, which is the wrong default for a field an
// older client knows nothing about: an absent value must NOT lift someone's EXISTING limit. So this
// column alone is keep-on-absent on UPDATE, and because the "без ограничения" choice is ITSELF a
// NULL, the upsert spells the coalesce out as a CASE. The tests below pin the three inbound cases
// (absent / explicit no-limit / a number) at the level of the SQL that is actually bound, plus the
// 400 for junk.
// ─────────────────────────────────────────────────────────────────────────────

/** Param slots added by the cap: 11 = VALUES nullif-input, 12 = UPDATE case-input (13 = its nullif). */
const capValuesParam = (calls: Call[]) => insertParams(calls)[11];
const capUpdateParam = (calls: Call[]) => insertParams(calls)[12];
type Call = { text: string; params: unknown[] };

/** Like makeSql, but the upsert answers its RETURNING clause with a stored cap. */
function makeSqlStoring(storedCap: number | null) {
  const calls: Call[] = [];
  const fn = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<Row[]> => {
    const text = Array.isArray(strings) ? (strings as unknown as string[]).join('?') : String(strings);
    calls.push({ text, params });
    if (/insert into subscriptions/.test(text)) return Promise.resolve([{ notify_daily_cap: storedCap }]);
    return Promise.resolve([]);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { fn: fn as any, calls };
}

describe('subscriptionPost — notify_daily_cap: absent must never lift an existing limit', () => {
  it('ABSENT field binds null, so the UPDATE branch keeps subscriptions.notify_daily_cap', async () => {
    const { fn, calls } = makeSqlStoring(20); // the row already had a 20/day limit
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();

    await subscriptionPost(makeReq({ notify: true }), res as unknown as ResLike);

    expect(capValuesParam(calls)).toBe(null);
    expect(capUpdateParam(calls)).toBe(null);
    // The keep-on-absent branch must literally be there — this is the whole point of the column.
    expect(insertParams(calls) && calls.find((c) => /insert into subscriptions/.test(c.text))!.text).toContain(
      'then subscriptions.notify_daily_cap',
    );
    // ...and the echo reports the value the DB kept, not "no limit".
    expect(bodyOf(res).notify_daily_cap).toBe(20);
  });

  it('a BRAND-NEW row created without the field is stored UNLIMITED (NULL), never with a default', async () => {
    // Owner, 2026-07-26: «всем без ограничений. Захотят изменить — то изменят в настройках кол-во».
    // The DB answers RETURNING with NULL because `nullif(null, 0)` is what the INSERT stores.
    const { fn, calls } = makeSqlStoring(null);
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();

    await subscriptionPost(makeReq({ notify: true }), res as unknown as ResLike);

    // Nothing numeric is bound at all: with the field absent there is simply no default cap to
    // bind, so no ceiling can reach the fresh row.
    expect(insertParams(calls).filter((p) => typeof p === 'number')).toEqual([]);
    expect(capValuesParam(calls)).toBe(null); // absent -> null -> nullif(null, 0) = SQL NULL
    expect(bodyOf(res).notify_daily_cap).toBe(null);
    // ...and a stored NULL means the notify run never limits this person (the send-side rule).
    expect(isOverDailyCap(1_000, bodyOf(res).notify_daily_cap as number | null)).toBe(false);
  });
});

describe('subscriptionPost — notify_daily_cap: explicit choices', () => {
  it('null means "без ограничения": bound as the 0 sentinel, stored (and echoed) as null', async () => {
    const { fn, calls } = makeSqlStoring(null);
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();

    await subscriptionPost(makeReq({ notify: true, notify_daily_cap: null }), res as unknown as ResLike);

    // 0, not null — null on the wire would be indistinguishable from "absent" and silently ignored.
    expect(capValuesParam(calls)).toBe(0);
    expect(capUpdateParam(calls)).toBe(0);
    expect(calls.find((c) => /insert into subscriptions/.test(c.text))!.text).toContain('nullif(');
    expect(bodyOf(res).notify_daily_cap).toBe(null);
  });

  it('0 is accepted as the same "no limit" choice as null', async () => {
    const { fn, calls } = makeSqlStoring(null);
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();

    await subscriptionPost(makeReq({ notify_daily_cap: 0 }), res as unknown as ResLike);

    expect(res.statusCode).toBe(200);
    expect(capValuesParam(calls)).toBe(0);
    expect(bodyOf(res).notify_daily_cap).toBe(null);
  });

  for (const choice of [5, 10, 20, 50]) {
    it(`stores and echoes the ${choice}/day option from the settings screen`, async () => {
      const { fn, calls } = makeSqlStoring(choice);
      vi.mocked(getSql).mockReturnValue(fn);
      const res = makeRes();

      await subscriptionPost(makeReq({ notify: true, notify_daily_cap: choice }), res as unknown as ResLike);

      expect(res.statusCode).toBe(200);
      expect(capValuesParam(calls)).toBe(choice);
      expect(capUpdateParam(calls)).toBe(choice);
      expect(bodyOf(res).notify_daily_cap).toBe(choice);
    });
  }

  it('the echo comes from RETURNING, so it can never disagree with what the DB stored', async () => {
    const { fn } = makeSqlStoring(50); // DB says 50 (e.g. a concurrent save won)
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();

    await subscriptionPost(makeReq({ notify_daily_cap: 5 }), res as unknown as ResLike);

    expect(bodyOf(res).notify_daily_cap).toBe(50);
  });
});

describe('subscriptionPost — notify_daily_cap: a malformed value is rejected, not fixed up', () => {
  for (const bad of [-1, 501, 1.5, '10', true, [], {}] as unknown[]) {
    it(`400 for ${JSON.stringify(bad) ?? String(bad)} — and NOTHING is written`, async () => {
      const { fn, calls } = makeSqlStoring(null);
      vi.mocked(getSql).mockReturnValue(fn);
      const res = makeRes();

      await subscriptionPost(makeReq({ notify: true, notify_daily_cap: bad }), res as unknown as ResLike);

      expect(res.statusCode).toBe(400);
      expect(calls).toHaveLength(0); // the whole save is refused before any DB work
    });
  }
});
