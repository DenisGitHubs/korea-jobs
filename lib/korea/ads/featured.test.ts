// lib/korea/ads/featured.test.ts
//
// FEATURED placements («избранные», owner decision 2026-10-21) — the guards that must never bend.
//
// WHAT IS PROVEN HOW (honesty about the instrument, same reasoning as notify/run.test.ts):
//   * BEHAVIOUR — driven through the REAL handlers (adsCreate, moderateAd) against a fake
//     tagged-template `sql`: that an approval issues exactly ONE grant statement for exactly the
//     right ad, that a pending/rejected outcome issues NONE, and that a capped or failing grant
//     cannot change the answer the author gets.
//   * SQL — the one-live-per-author cap, "once per ad", "only approved", "never a promo" are a
//     WHERE clause. A fake `sql` cannot evaluate a WHERE clause, so they are asserted AS SQL TEXT;
//     a test that pretended to evaluate them would only be proving its own fake. The live proof is
//     the two SANITY selects at the end of db/migrations/draft_0033_featured_ads.sql.
//   * TIME — the deadline is computed by Postgres (now() + make_interval), exactly like the sibling
//     expires_at, so the "7 days" assertion is on the BOUND PARAM (change 7 to 3 and it reddens);
//     there is no app-side clock to substitute here, and korea-jobs has no live-DB tests.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted fake state so the vi.mock factories (hoisted above the imports) can reach it.
const h = vi.hoisted(() => {
  const state = {
    queries: [] as { text: string; params: unknown[] }[],
    insertId: '11111111-1111-1111-1111-111111111111' as string | null,
    /** The grant UPDATE's result: 1 row = week granted, 0 rows = capped / already granted. */
    grantRows: 1,
    /** Make the grant statement fail the way a not-yet-applied draft_0033 would. */
    grantThrows: false,
    /** The admin moderation UPDATE's result (0 rows = the ad was not 'pending' any more). */
    moderateRows: 1,
    /**
     * Does the row carry «Я не беру плату с работников» (draft_0035)? false models the real case
     * 007 found: an ad created BEFORE the rule, or one that sat in moderation when it shipped.
     */
    adConfirmed: true,
  };
  const adTextRow = {
    title: 'Рабочий на завод',
    description: 'Требуется рабочий на производство.',
    salary_text: null,
    schedule: null,
    housing_terms: null,
    meals_info: null,
  };
  const fakeSql = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<unknown[]> => {
    const text = typeof strings === 'string' ? strings : strings.join(' ? ');
    state.queries.push({ text, params });
    if (text.includes('from cities')) return Promise.resolve([]);
    if (text.includes('insert into user_ads')) {
      return Promise.resolve(state.insertId ? [{ id: state.insertId }] : []);
    }
    // The grant (ads/featured.ts) — the ONLY statement that names featured_until.
    if (text.includes('featured_until')) {
      if (state.grantThrows) {
        return Promise.reject(new Error('column "featured_until" of relation "user_ads" does not exist'));
      }
      // Here the fake plays POSTGRES for exactly ONE predicate, and its truth table comes from SQL
      // semantics, not from the code under test: a row WITHOUT the confirmation cannot match a
      // statement that filters on `no_worker_fee_confirmed_at is not null`, and CAN match one that
      // does not filter on it. That is what makes the canary below a real discriminator — drop the
      // condition from the UPDATE and the fake starts answering "granted".
      const filtersOnConfirmation = text.includes('t.no_worker_fee_confirmed_at is not null');
      if (!state.adConfirmed && filtersOnConfirmation) return Promise.resolve([]);
      return Promise.resolve(state.grantRows > 0 ? [{ id: state.insertId }] : []);
    }
    if (text.includes('update user_ads')) {
      return Promise.resolve(state.moderateRows > 0 ? [adTextRow] : []);
    }
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('../core/context.js', () => ({
  authenticate: async () => ({
    ok: true,
    user: { id: '00000000-0000-0000-0000-000000000001', telegramId: '1', publicId: 'abc', lang: 'ru', allowsWriteToPm: true, isBlocked: false },
  }),
}));
vi.mock('../config.js', () => ({
  getConfigNumber: async (_k: string, fb: number) => fb,
  getConfigBool: async (_k: string, fb: boolean) => fb,
  getConfigString: async (_k: string, fb: string) => fb,
}));
vi.mock('../bot/telegram.js', () => ({ sendMessage: async () => ({ ok: true }) }));
vi.mock('../admin/auth.js', () => ({ adminRecipients: async () => [], requireAdmin: async () => ({ ok: false }) }));
vi.mock('../notify/author.js', () => ({ notifyAuthorAdDecision: async () => undefined }));

// The moderation verdict is the project's single decision point; drive it from the test.
const decideMock = vi.fn(async () => ({
  status: 'approved' as 'approved' | 'pending' | 'rejected',
  rejectReason: null as string | null,
  item: { is_vacancy: true, confidence: 0.95, city_slug: null as string | null, region_slug: null as string | null } as unknown,
  cityIdBySlug: new Map<string, string>(),
  aiConfidence: 0.95 as number | null,
}));
vi.mock('./moderation.js', () => ({
  decideAdModeration: (...a: unknown[]) => decideMock(...(a as [])),
  recordModerationExample: async () => {},
}));

import { adsCreate, moderateAd } from './rw.js';
import {
  grantFeaturedOnApproval,
  revokeFeaturedOnReport,
  featuredLiveSql,
  FEATURED_DAYS_DEFAULT,
  FEATURED_DAYS_KEY,
} from './featured.js';
import type { ReqLike, ResLike } from '../core/http.js';

const AD_ID = '11111111-1111-1111-1111-111111111111';

/** An ad text that limits nobody — the normal case. */
const CLEAN_TEXT = 'Рабочий на завод\nТребуется рабочий на производство, стабильная зарплата.';
/** 🔴 The same ad, now limiting the audience by GENDER — the lift must be refused. */
const GENDER_TEXT = 'Упаковка\nТребуются только женщины на упаковку, стабильная зарплата.';

function makeReq(body: unknown): ReqLike {
  return { method: 'POST', headers: { authorization: 'tma stub' }, body };
}
function makeRes(): ResLike & { _status: number; _body: unknown } {
  return {
    _status: 0,
    _body: undefined,
    statusCode: 0,
    setHeader() {},
    end(b: string) {
      this._status = this.statusCode;
      this._body = JSON.parse(b);
    },
  };
}

const adBody = {
  title: 'Рабочий на завод',
  description: 'Требуется рабочий на производство, стабильная зарплата, оформление.',
  // Mandatory since 2026-10-21 (draft_0035) — without it the create is refused outright.
  no_worker_fee: true,
  contact_raw: '+821012345678',
  work_type: 'factory',
  visa_types: ['e9'],
  placement_fee: 'free',
  has_housing: true,
  has_meals: false,
  city_slug: null,
  city_text: 'Кёнджу',
  region_slug: null,
};

/** Every statement that names featured_until — i.e. every grant attempt. */
const grants = () => h.state.queries.filter((q) => q.text.includes('featured_until'));

beforeEach(() => {
  h.state.queries = [];
  h.state.insertId = AD_ID;
  h.state.grantRows = 1;
  h.state.grantThrows = false;
  h.state.moderateRows = 1;
  h.state.adConfirmed = true;
  decideMock.mockClear();
  decideMock.mockImplementation(async () => ({
    status: 'approved' as const,
    rejectReason: null,
    item: { is_vacancy: true, confidence: 0.95, city_slug: null, region_slug: null } as unknown,
    cityIdBySlug: new Map<string, string>(),
    aiConfidence: 0.95,
  }));
});

// ─────────────────────────────────────────────────────────────────────────────
// The grant itself
// ─────────────────────────────────────────────────────────────────────────────

describe('grantFeaturedOnApproval — one statement, every condition inside it', () => {
  it('gives the week as now() + make_interval(days => 7), with 7 as a BOUND param', async () => {
    const ok = await grantFeaturedOnApproval(h.fakeSql as never, AD_ID, CLEAN_TEXT);

    expect(ok).toBe(true);
    expect(grants()).toHaveLength(1);
    const g = grants()[0]!;
    expect(g.text).toContain('set featured_until = now() + make_interval(days =>');
    // The owner's number, from code/config — never hard-coded into the SQL text.
    expect(FEATURED_DAYS_DEFAULT).toBe(7);
    expect(FEATURED_DAYS_KEY).toBe('ads_featured_days');
    expect(g.params[0]).toBe(7); // days
    expect(g.params[1]).toBe(AD_ID); // the ad being lifted
  });

  it('🔴 carries the ONE-LIVE-PER-AUTHOR cap in the same statement (not a read-then-write)', async () => {
    await grantFeaturedOnApproval(h.fakeSql as never, AD_ID, CLEAN_TEXT);
    const q = grants()[0]!.text;

    // A second ad of the SAME author is excluded while the first week is still running.
    expect(q).toContain('not exists');
    expect(q).toContain('from user_ads o');
    expect(q).toContain('o.author_user_id = t.author_user_id');
    expect(q).toContain('o.id <> t.id');
    expect(q).toContain('o.featured_until > now()');
    // The cap is NOT narrowed to feed-visible rows: an archived ad whose week still runs must keep
    // blocking, otherwise archive → grant → unarchive puts two featured ads of one author on top.
    expect(q).not.toContain("o.status = 'approved'");
  });

  it('grants at most ONCE per ad and only to an APPROVED, non-promo ad with an author', async () => {
    await grantFeaturedOnApproval(h.fakeSql as never, AD_ID, CLEAN_TEXT);
    const q = grants()[0]!.text;

    expect(q).toContain('t.featured_until is null'); // an edit/unarchive cycle cannot renew the week
    expect(q).toContain("t.status = 'approved'"); // a pending/rejected ad is never lifted
    expect(q).toContain('t.author_user_id is not null'); // an orphaned ad has no author to cap
    // 🔴 A PAID placement never receives the FREE privilege (draft_0030: promo gets no ranking lift).
    expect(q).toContain('not coalesce(t.promo, false)');
  });

  it('reports false when the DB granted nothing (capped author / already granted)', async () => {
    h.state.grantRows = 0;
    expect(await grantFeaturedOnApproval(h.fakeSql as never, AD_ID, CLEAN_TEXT)).toBe(false);
  });

  it('is BEST-EFFORT: a missing column (draft_0033 not applied) returns false and never throws', async () => {
    h.state.grantThrows = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(grantFeaturedOnApproval(h.fakeSql as never, AD_ID, CLEAN_TEXT)).resolves.toBe(false);

    // The reason is logged (message only) instead of being swallowed in silence.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 The GENDER gate (Законник, 2026-10-21) — BOTH canaries, side by side
// ─────────────────────────────────────────────────────────────────────────────
//
// This pair is the whole guard: without the second line a broken detector would still look green,
// and without the first line "refuse everything" would too.
describe('grantFeaturedOnApproval — a gender-restricted ad is never lifted', () => {
  it('🔴 gender-restricted text → NO lift, and not even a query is spent on it', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const ok = await grantFeaturedOnApproval(h.fakeSql as never, AD_ID, GENDER_TEXT);

    expect(ok).toBe(false);
    expect(grants()).toHaveLength(0); // refused BEFORE the UPDATE — the ad is never lifted at all
    // The log says WHAT and HOW MANY, never the phrase itself (it is a person's ad text).
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('gender-restricted');
    expect(logged).not.toContain('женщин');
    spy.mockRestore();
  });

  it('the very same ad WITHOUT the restriction IS lifted (the gate is not "refuse everything")', async () => {
    const ok = await grantFeaturedOnApproval(h.fakeSql as never, AD_ID, CLEAN_TEXT);

    expect(ok).toBe(true);
    expect(grants()).toHaveLength(1);
  });

  it('through the REAL create handler: a gender-restricted ad is published, just not lifted', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = makeRes();

    await adsCreate(
      makeReq({ ...adBody, title: 'Упаковка', description: 'Требуются только женщины на упаковку, оплата недельная.' }),
      res as unknown as ResLike,
    );

    expect(res._status).toBe(200); // nothing breaks — it is an ordinary ad now
    expect(res._body).toMatchObject({ status: 'approved' });
    expect(grants()).toHaveLength(0);
    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 NO CONFIRMATION «Я не беру плату с работников» → NO WEEK (owner 2026-10-21, after 007/m4)
// ─────────────────────────────────────────────────────────────────────────────
//
// The hole 007 found: the grant is also reached from the EDIT, the UNARCHIVE and the manual
// approve, and those act on rows created BEFORE the rule (no_worker_fee_confirmed_at IS NULL) and
// on everything that was waiting in moderation when it shipped — so an old, unconfirmed ad used to
// collect the privilege just by being saved again. Both canaries live here side by side: without
// the second one, "refuse everybody" would look just as green.
describe('the week is granted only to an ad that confirmed it takes no money from workers', () => {
  it('🔴 an ad WITHOUT the confirmation does not become featured', async () => {
    h.state.adConfirmed = false;

    const ok = await grantFeaturedOnApproval(h.fakeSql as never, AD_ID, CLEAN_TEXT);

    expect(ok).toBe(false);
    // The condition travels in the SAME statement as every other one, so no route can bypass it.
    expect(grants()[0]!.text).toContain('and t.no_worker_fee_confirmed_at is not null');
  });

  it('the very same ad WITH the confirmation does become featured', async () => {
    h.state.adConfirmed = true;

    const ok = await grantFeaturedOnApproval(h.fakeSql as never, AD_ID, CLEAN_TEXT);

    expect(ok).toBe(true);
    expect(grants()).toHaveLength(1);
  });

  it('🔴 and it still PUBLISHES: a manual approve of an unconfirmed ad succeeds, just without the lift', async () => {
    h.state.adConfirmed = false;

    const r = await moderateAd(AD_ID, 'approve', null);

    // The ad is approved and in the feed — losing a bonus must never look like losing the ad.
    expect(r.found).toBe(true);
    const statusUpdate = h.state.queries.find((q) => /update user_ads\s+set status =/.test(q.text));
    expect(statusUpdate, 'the moderation UPDATE still ran').toBeTruthy();
    // One attempt at the week, and it granted nothing.
    expect(grants()).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 PAID placements get NO lift (draft_0030's invariant, now in a test and not a comment)
// ─────────────────────────────────────────────────────────────────────────────
describe('promo (PAID) placements are untouched by the featured mechanics', () => {
  it('🔴 the grant itself excludes a promo row', async () => {
    await grantFeaturedOnApproval(h.fakeSql as never, AD_ID, CLEAN_TEXT);
    expect(grants()[0]!.text).toContain('not coalesce(t.promo, false)');
  });

  it('the scheduled publisher (the only writer of promo rows) never calls the grant', async () => {
    // Structural, and deliberately so: scheduled/run.ts publishes the owner's own cards straight
    // into user_ads, and a promo one must stay an ordinary card in the ordinary stream. If anybody
    // wires the grant into that worker, this line reddens.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../scheduled/run.ts', import.meta.url), 'utf8'),
    );
    expect(src).not.toContain('grantFeaturedOnApproval');
    expect(src).not.toContain('featured_until');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Revoking the lift (the mechanics behind "first complaint takes the lift")
// ─────────────────────────────────────────────────────────────────────────────
describe('revokeFeaturedOnReport — ends the week, touches nothing else', () => {
  it('expires featured_until and does NOT change status / expires_at / visibility', async () => {
    const ok = await revokeFeaturedOnReport(h.fakeSql as never, AD_ID);

    expect(ok).toBe(true);
    expect(grants()).toHaveLength(1);
    const q = grants()[0]!.text;
    expect(q).toContain('update user_ads set featured_until = now()');
    // The ad itself is left alone — removing an AD is a human's decision, not a complaint's.
    expect(q).not.toContain('status');
    expect(q).not.toContain('expires_at');
    // 🔴 and NOT `= null`: NULL means "never featured", which is also what ALLOWS a grant — blanking
    // it would let a reported author get lifted again by editing the ad.
    expect(q).not.toContain('featured_until = null');
    expect(q).toContain('featured_until > now()'); // idempotent: only a LIVE week is ended
  });

  it('is best-effort: a missing column returns false and never throws', async () => {
    h.state.grantThrows = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(revokeFeaturedOnReport(h.fakeSql as never, AD_ID)).resolves.toBe(false);
    spy.mockRestore();
  });
});

describe('featuredLiveSql — the ONE expression behind both the badge and the ordering', () => {
  it('is featured_until > now(), read through to_jsonb (survives a deploy before the migration)', () => {
    const e = featuredLiveSql('a');
    expect(e).toBe("coalesce(((to_jsonb(a) ->> 'featured_until')::timestamptz) > now(), false)");
    // No bare column: naming a not-yet-migrated column would break the app's main screen.
    expect(e).not.toMatch(/\ba\.featured_until\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The approval routes — where the grant is (and is not) issued
// ─────────────────────────────────────────────────────────────────────────────

describe('adsCreate — an ad placed through OUR FORM is featured once it is approved', () => {
  it('auto-approved → exactly one grant, for the ad just inserted, after the INSERT', async () => {
    const res = makeRes();
    await adsCreate(makeReq(adBody), res as unknown as ResLike);

    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ id: AD_ID, status: 'approved' });
    expect(grants()).toHaveLength(1);
    expect(grants()[0]!.params[1]).toBe(AD_ID);
    const iInsert = h.state.queries.findIndex((q) => q.text.includes('insert into user_ads'));
    const iGrant = h.state.queries.findIndex((q) => q.text.includes('featured_until'));
    expect(iInsert).toBeGreaterThanOrEqual(0);
    expect(iGrant).toBeGreaterThan(iInsert); // the row must exist before it can be lifted
  });

  it('routed to PENDING review → no grant at all (a card nobody sees is never lifted)', async () => {
    decideMock.mockImplementation(async () => ({
      status: 'pending' as const,
      rejectReason: null,
      item: null,
      cityIdBySlug: new Map<string, string>(),
      aiConfidence: null,
    }));
    const res = makeRes();
    await adsCreate(makeReq(adBody), res as unknown as ResLike);

    expect(res._body).toMatchObject({ status: 'pending' });
    expect(grants()).toHaveLength(0);
  });

  it('REJECTED → no grant at all', async () => {
    decideMock.mockImplementation(async () => ({
      status: 'rejected' as const,
      rejectReason: 'ads',
      item: null,
      cityIdBySlug: new Map<string, string>(),
      aiConfidence: null,
    }));
    const res = makeRes();
    await adsCreate(makeReq(adBody), res as unknown as ResLike);

    expect(res._body).toMatchObject({ status: 'rejected' });
    expect(grants()).toHaveLength(0);
  });

  it('🔴 a CAPPED author still gets an ordinary published ad: 200, approved, nothing else changes', async () => {
    // The DB answers "0 rows updated" exactly as it does for an author whose first week is alive
    // (the cap lives in the WHERE above). What this pins is the CALLER's half: the ad is published
    // as an ordinary card, the author is not told anything different, and no retry is attempted.
    h.state.grantRows = 0;
    const res = makeRes();
    await adsCreate(makeReq(adBody), res as unknown as ResLike);

    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ id: AD_ID, status: 'approved' });
    expect(grants()).toHaveLength(1); // one attempt, no second try
  });

  it('a grant fault never costs us the ad: the create still answers 200/approved', async () => {
    h.state.grantThrows = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes();
    await adsCreate(makeReq(adBody), res as unknown as ResLike);

    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ status: 'approved' });
    spy.mockRestore();
  });
});

describe('moderateAd — a manual approve earns the same week; a reject earns nothing', () => {
  it('approve → one grant for that ad id', async () => {
    const r = await moderateAd(AD_ID, 'approve', null);

    expect(r.found).toBe(true);
    expect(grants()).toHaveLength(1);
    expect(grants()[0]!.params[1]).toBe(AD_ID);
  });

  it('reject → no grant', async () => {
    const r = await moderateAd(AD_ID, 'reject', 'не вакансия');

    expect(r.found).toBe(true);
    expect(grants()).toHaveLength(0);
  });

  it('a stale button (the ad is no longer pending) grants nothing', async () => {
    h.state.moderateRows = 0;
    const r = await moderateAd(AD_ID, 'approve', null);

    expect(r.found).toBe(false);
    expect(grants()).toHaveLength(0);
  });
});
