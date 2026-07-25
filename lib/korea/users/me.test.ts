// lib/korea/users/me.test.ts
//
// GET /api/me — the settings screen must never LIE about the mailing state (owner rule 2026-07-25).
//
// A user with NO subscription row receives nothing at all: both notify/run.ts and digest/run.ts
// INNER JOIN subscriptions, so no row = no mail, ever. /me used to report notify=true and
// digest_enabled=true for exactly that user, so the settings toggles looked ENABLED while not a
// single message was being sent. These tests pin the honest answer (false/false) for the cold case,
// the pass-through of a real row, and that `no_city` — a FEED widening rule, not a mailing switch —
// keeps its true default. Also pins flags.hide_unverified (the «Не проверено» kill-switch) being
// echoed for the client.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/db.js', () => ({ getSql: vi.fn() }));
vi.mock('../core/context.js', () => ({ authenticate: vi.fn() }));
vi.mock('../config.js', () => ({
  getConfigString: vi.fn(async (_k: string, fallback: string) => fallback),
  getConfigNumber: vi.fn(async (_k: string, fallback: number) => fallback),
  getConfigBool: vi.fn(async (_k: string, fallback: boolean) => fallback),
}));
vi.mock('../streaks/update.js', () => ({
  readStreakSummary: vi.fn(async () => ({ visitLen: 0, openLen: 0, bonusTotal: 0 })),
}));
vi.mock('../vacancies/read.js', () => ({ reveals24h: vi.fn(async () => 0) }));

import type { ReqLike, ResLike } from '../core/http.js';
import { getSql } from '../core/db.js';
import { authenticate } from '../core/context.js';
import { getConfigBool } from '../config.js';
import { meGet } from './me.js';

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

type Row = Record<string, unknown>;

/** Fake `sql` tagged template routed by statement shape. `sub` = the subscriptions row (or none). */
function makeSql(sub: Row | null) {
  const fn = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<Row[]> => {
    const text = Array.isArray(strings) ? (strings as unknown as string[]).join('?') : String(strings);
    void params;
    if (/from subscriptions/.test(text)) return Promise.resolve(sub ? [sub] : []);
    if (/from cities/.test(text)) return Promise.resolve([{ slug: 'ansan' }]);
    if (/from users/.test(text))
      return Promise.resolve([{ terms_accepted_at: null, terms_version: null, onboarded_at: null }]);
    if (/from referral_points_ledger/.test(text)) return Promise.resolve([{ points_total: 0 }]);
    return Promise.resolve([]);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return fn as any;
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
const subOf = (res: { body: string }) => bodyOf(res).subscription as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticate).mockResolvedValue({ ok: true, user: { id: USER_ID, publicId: 'pub1', lang: 'ru' } } as never);
  vi.mocked(getConfigBool).mockImplementation(async (_k: string, fallback: boolean) => fallback);
});

describe('meGet — an unsubscribed user is reported as OFF, not as on', () => {
  it('NO subscription row: notify=false and digest_enabled=false (no mail is sent to them, so no lie)', async () => {
    vi.mocked(getSql).mockReturnValue(makeSql(null));
    const res = makeRes();
    await meGet(makeReq(), res as unknown as ResLike);

    expect(res.statusCode).toBe(200);
    expect(subOf(res).notify).toBe(false);
    expect(subOf(res).digest_enabled).toBe(false);
  });

  it('NO subscription row: no_city stays TRUE — it widens the FEED, it is not a mailing switch', async () => {
    vi.mocked(getSql).mockReturnValue(makeSql(null));
    const res = makeRes();
    await meGet(makeReq(), res as unknown as ResLike);

    expect(subOf(res).no_city).toBe(true);
    expect(subOf(res)).toMatchObject({ city_slugs: [], region_slugs: [], work_types: [], visa_types: [] });
  });

  it('a real row is passed through verbatim (both flags on)', async () => {
    vi.mocked(getSql).mockReturnValue(
      makeSql({
        city_ids: [],
        region_slugs: ['gyeonggi'],
        work_types: ['factory'],
        notify: true,
        digest_enabled: true,
        no_city: false,
        visa_types: ['f4'],
        placement_fee: 'free',
        require_housing: true,
        require_meals: null,
      }),
    );
    const res = makeRes();
    await meGet(makeReq(), res as unknown as ResLike);

    expect(subOf(res)).toMatchObject({
      notify: true,
      digest_enabled: true,
      no_city: false,
      region_slugs: ['gyeonggi'],
      work_types: ['factory'],
      visa_types: ['f4'],
      placement_fee: 'free',
      require_housing: true,
      require_meals: null,
    });
  });

  it('a real row with the flags OFF is NOT flipped back on (the old `?? true` fallback is gone)', async () => {
    vi.mocked(getSql).mockReturnValue(
      makeSql({
        city_ids: [],
        region_slugs: [],
        work_types: [],
        notify: false,
        digest_enabled: false,
        no_city: true,
        visa_types: [],
        placement_fee: null,
        require_housing: null,
        require_meals: null,
      }),
    );
    const res = makeRes();
    await meGet(makeReq(), res as unknown as ResLike);

    expect(subOf(res).notify).toBe(false);
    expect(subOf(res).digest_enabled).toBe(false);
  });

  it('a NULL digest flag (deploy-before-migration window) reads as OFF, never as on', async () => {
    vi.mocked(getSql).mockReturnValue(
      makeSql({
        city_ids: [],
        region_slugs: [],
        work_types: [],
        notify: true,
        digest_enabled: null,
        no_city: null,
        visa_types: [],
        placement_fee: null,
        require_housing: null,
        require_meals: null,
      }),
    );
    const res = makeRes();
    await meGet(makeReq(), res as unknown as ResLike);

    expect(subOf(res).digest_enabled).toBe(false);
    expect(subOf(res).no_city).toBe(true); // unchanged: null no_city still widens the feed
  });

  it('flags.hide_unverified mirrors the config switch (default false = the tab stays)', async () => {
    vi.mocked(getSql).mockReturnValue(makeSql(null));

    const off = makeRes();
    await meGet(makeReq(), off as unknown as ResLike);
    expect(bodyOf(off).flags).toEqual({ hide_unverified: false });

    vi.mocked(getConfigBool).mockImplementation(async (k: string, fallback: boolean) =>
      k === 'hide_unverified' ? true : fallback,
    );
    const on = makeRes();
    await meGet(makeReq(), on as unknown as ResLike);
    expect(bodyOf(on).flags).toEqual({ hide_unverified: true });
  });

  it('401 without initData; 404 for a non-GET method', async () => {
    vi.mocked(getSql).mockReturnValue(makeSql(null));

    const r1 = makeRes();
    await meGet(makeReq('POST'), r1 as unknown as ResLike);
    expect(r1.statusCode).toBe(404);

    vi.mocked(authenticate).mockResolvedValueOnce({ ok: false } as never);
    const r2 = makeRes();
    await meGet(makeReq(), r2 as unknown as ResLike);
    expect(r2.statusCode).toBe(401);
  });
});
