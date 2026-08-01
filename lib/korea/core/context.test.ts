// lib/korea/core/context.test.ts
//
// The Mini App entry path. `authenticate()` is the ONLY place a mini-app visitor's row is
// created, so it is also the only place the acquisition label from a campaign link
// (`?startapp=ads_ru1`, Telegram Ads) can be recorded. What is pinned here:
//
//   * a campaign link stores the slug — in the INSERT column list ONLY, never in the
//     ON CONFLICT branch (that IS the immutability guarantee: a second visit / another
//     campaign link / an account that already existed can never rewrite it);
//   * a referral link keeps binding referred_by and stores NO label (an ad visitor must not
//     appear in the referral numbers, and vice versa);
//   * a plain launch runs the untouched label-less upsert;
//   * if users.acq_source does not exist yet (deploy before migrate), auth still SUCCEEDS via
//     the label-less fallback — a paid click must never end in a locked door;
//   * since 02.08.2026 the label must ALSO be on the owner's allow-list (config
//     acq_sources_allowed, gate in core/acq-source.ts): `?startapp=` is public, so anyone could
//     otherwise write free text into their own row — text that survives account erasure. An
//     unapproved label degrades to "no label" (never to a locked door) and is only COUNTED.
//
// The DB, initData verification, config and the streak bump are faked; the assertions are on
// the SQL text + bound values the upsert actually produced.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    /** start_param carried by the verified initData ('' = none). */
    startParam: '',
    /** Query texts (whitespace-collapsed) in call order. */
    queries: [] as string[],
    /** Bound values per query, same order. */
    values: [] as unknown[][],
    /** When true, any statement naming acq_source throws (column not migrated yet). */
    noAcqColumn: false,
    /** config.acq_sources_allowed — the labels the owner approved (draft_0032). */
    allowed: ['ads_ru1', 'ads_ru2', 'ads_uz1', 'ads_uz2'] as string[],
  };
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    state.queries.push(q);
    state.values.push(values);
    if (state.noAcqColumn && q.includes('acq_source')) {
      return Promise.reject(new Error('column "acq_source" of relation "users" does not exist'));
    }
    if (q.includes('insert into users')) {
      return Promise.resolve([
        {
          id: 'user-1',
          telegram_id: 555,
          public_id: 'a1b2c3d4e5f60718',
          lang: 'ru',
          allows_write_to_pm: true,
          is_blocked: false,
          visit_streak_day: null,
        },
      ]);
    }
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('./db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('./auth.js', () => ({
  verifyInitData: () => ({
    ok: true,
    identity: {
      telegramId: 555,
      username: 'ivanp',
      firstName: 'Иван',
      lastName: null,
      languageCode: 'ru',
      allowsWriteToPm: true,
      ...(h.state.startParam ? { startParam: h.state.startParam } : {}),
    },
  }),
}));
vi.mock('../config.js', () => ({
  getConfigNumber: async (_k: string, fb: number) => fb,
  getConfigString: async (_k: string, fb: string) => fb,
  getConfigBool: async (_k: string, fb: boolean) => fb,
  getConfigStringArray: async (k: string, fb: string[]) =>
    k === 'acq_sources_allowed' ? h.state.allowed : fb,
}));
vi.mock('../streaks/update.js', () => ({ bumpVisitStreakBestEffort: async () => {} }));

import { authenticate } from './context.js';
import type { ReqLike } from './http.js';

const REF = 'a1b2c3d4e5f60718';
const VAC = '0f8c2a1b3d4e4f5a6b7c8d9e0f1a2b3c';

function req(): ReqLike {
  return { method: 'GET', headers: { authorization: 'tma user=%7B%22id%22%3A555%7D&hash=x' } };
}

/** The users upsert this call produced. */
function upsert(): string {
  const q = h.state.queries.find((x) => x.includes('insert into users'));
  if (!q) throw new Error('no users upsert was issued');
  return q;
}

/** Everything AFTER `do update set` — the branch a RETURNING visitor takes. */
function conflictBranch(): string {
  const q = upsert();
  const i = q.indexOf('do update set');
  expect(i).toBeGreaterThan(-1);
  return q.slice(i);
}

beforeEach(() => {
  process.env.BOT_TOKEN = 'test-token';
  h.state.startParam = '';
  h.state.queries = [];
  h.state.values = [];
  h.state.noAcqColumn = false;
  h.state.allowed = ['ads_ru1', 'ads_ru2', 'ads_uz1', 'ads_uz2'];
});

/** True when this call ticked the "a label missed the allow-list" counter. */
function rejectCounted(): boolean {
  return h.state.queries.some((q) => q.includes('insert into acq_rejects'));
}

describe('authenticate — campaign label (?startapp=ads_ru1)', () => {
  it('stores the label and lets the person in', async () => {
    h.state.startParam = 'ads_ru1';
    const res = await authenticate(req());

    expect(res.ok).toBe(true);
    expect(upsert()).toContain('acq_source');
    // The label itself is a BOUND value, never interpolated into the statement.
    expect(h.state.values[0]).toContain('ads_ru1');
  });

  it('writes the label on INSERT ONLY — the ON CONFLICT branch never mentions it', async () => {
    h.state.startParam = 'ads_ru1';
    await authenticate(req());

    // The column IS in the insert list…
    expect(upsert()).toMatch(/insert into users \([^)]*acq_source/);
    // …and is NOT in the update branch: a repeat visit cannot overwrite where a person came from.
    expect(conflictBranch()).not.toContain('acq_source');
  });

  it('normalizes the label exactly like the parser (case + dash) — on BOTH sides', async () => {
    // The owner wrote it one way in the list, the ad cabinet sends it another: both fold to the
    // same canonical form, otherwise adding a label would silently not work.
    h.state.allowed = ['ADS_RU-1'];
    h.state.startParam = 'ADS_RU-1';
    await authenticate(req());
    expect(h.state.values[0]).toContain('ads_ru_1');
    expect(rejectCounted()).toBe(false);
  });

  it('never touches the referral graph — an ad visitor has no inviter', async () => {
    h.state.startParam = 'ads_uz1';
    await authenticate(req());
    const q = upsert();
    expect(q).not.toContain('referred_by');
    expect(q).not.toContain('ref_l2');
  });

  it('a malformed label is simply ignored: plain upsert, no label, still authenticated', async () => {
    h.state.startParam = 'ads_';
    const res = await authenticate(req());
    expect(res.ok).toBe(true);
    expect(upsert()).not.toContain('acq_source');
  });

  it('SURVIVES the deploy-before-migrate window: falls back to the label-less upsert', async () => {
    h.state.noAcqColumn = true;
    h.state.startParam = 'ads_ru1';
    const res = await authenticate(req());

    // A paid click must never hit a locked door: the person is authenticated anyway…
    expect(res.ok).toBe(true);
    // …by a SECOND statement that carries no label at all.
    const inserts = h.state.queries.filter((q) => q.includes('insert into users'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toContain('acq_source');
    expect(inserts[1]).not.toContain('acq_source');
  });
});

describe('authenticate — the label ALLOW-LIST (anybody can set ?startapp=…)', () => {
  it('an UNAPPROVED label is not stored, and the person still gets in', async () => {
    // A stranger writing free text about himself into his own row — the hole being closed.
    h.state.startParam = 's_ivan_petrov_seoul';
    const res = await authenticate(req());

    expect(res.ok).toBe(true);
    expect(upsert()).not.toContain('acq_source');
    // Exactly one users statement: it degraded to the plain upsert, not to a second attempt.
    expect(h.state.queries.filter((q) => q.includes('insert into users'))).toHaveLength(1);
  });

  it('counts the miss (so a typo in the ad cabinet surfaces) without storing the value', async () => {
    h.state.startParam = 'ads_ru9';
    await authenticate(req());

    expect(rejectCounted()).toBe(true);
    // The counter statement carries no bound values at all — nothing of the label is kept.
    const i = h.state.queries.findIndex((q) => q.includes('insert into acq_rejects'));
    expect(h.state.values[i]).toEqual([]);
    // …and the label is nowhere in anything we sent to the DB.
    expect(JSON.stringify(h.state.values)).not.toContain('ads_ru9');
  });

  it('an EMPTY list stores nothing at all (fail-closed: forgotten setup ≠ open door)', async () => {
    h.state.allowed = [];
    h.state.startParam = 'ads_ru1';
    const res = await authenticate(req());

    expect(res.ok).toBe(true);
    expect(upsert()).not.toContain('acq_source');
    expect(rejectCounted()).toBe(true);
  });

  it('an approved label is unaffected by the gate', async () => {
    h.state.startParam = 'ads_uz2';
    await authenticate(req());
    expect(upsert()).toContain('acq_source');
    expect(h.state.values[0]).toContain('ads_uz2');
    expect(rejectCounted()).toBe(false);
  });

  it('a link with no label never consults the list and never counts a rejection', async () => {
    h.state.allowed = [];
    h.state.startParam = REF; // a referral link
    await authenticate(req());
    expect(rejectCounted()).toBe(false);
  });
});

describe('authenticate — the other two link shapes are untouched', () => {
  it('a referral link still binds the inviter and stores NO label', async () => {
    h.state.startParam = REF;
    const res = await authenticate(req());

    expect(res.ok).toBe(true);
    const q = upsert();
    expect(q).toContain('referred_by');
    expect(q).not.toContain('acq_source');
  });

  it('a vacancy share carrying a ref code binds the inviter, stores NO label', async () => {
    h.state.startParam = `v${VAC}r${REF}`;
    await authenticate(req());

    const q = upsert();
    expect(q).toContain('referred_by');
    expect(q).not.toContain('acq_source');
  });

  it('a plain launch runs the label-less upsert (hot path unchanged)', async () => {
    const res = await authenticate(req());

    expect(res.ok).toBe(true);
    const q = upsert();
    expect(q).not.toContain('acq_source');
    expect(q).not.toContain('referred_by');
    expect(h.state.queries.filter((x) => x.includes('insert into users'))).toHaveLength(1);
  });

  it('returns the trusted user row regardless of the link shape', async () => {
    h.state.startParam = 'ads_ru1';
    const res = await authenticate(req());
    expect(res).toEqual({
      ok: true,
      user: {
        id: 'user-1',
        telegramId: '555',
        publicId: 'a1b2c3d4e5f60718',
        lang: 'ru',
        allowsWriteToPm: true,
        isBlocked: false,
      },
    });
  });
});
