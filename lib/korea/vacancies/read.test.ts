// lib/korea/vacancies/read.test.ts
//
// Three concerns, one module:
//  (2) The SHARED daily contact-reveal cap. reveals24h is driven directly with an injectable fake
//      `sql` (streaks/update.test.ts pattern); vacancyContact is driven through mocked getSql /
//      authenticate / config / referral so we exercise the REAL check-then-insert control flow on a
//      fake DB. We pin: the budget sums ALL THREE audit tables; a repeat reveal is free (budget never
//      consulted, no insert); hitting the cap → 429 with NO insert; the insert carries the
//      `on conflict … do nothing` race guard (23505 swallow).
//  (3) Characterization (snapshot) of the pure helpers parseFeedFilters / buildFilterWhere / cursor.
//      These pin CURRENT behavior as a safety net — they are NOT assertions of "correct" behavior.
//      Anything surprising is left AS-IS and reported, never "fixed" here.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// getSql / authenticate / config / referral are replaced so the handler runs against a fake DB with a
// fixed identity, no env and no network. reveals24h itself takes `sql` by injection (no mock needed).
vi.mock('../core/db.js', () => ({ getSql: vi.fn() }));
vi.mock('../core/context.js', () => ({ authenticate: vi.fn() }));
vi.mock('../config.js', () => ({
  getConfigNumber: vi.fn(async (_k: string, fallback: number) => fallback),
  getConfigString: vi.fn(async (_k: string, fallback: string) => fallback),
}));
vi.mock('../referral/accrue.js', () => ({ recordReferralActivation: vi.fn(async () => undefined) }));

import type { ReqLike, ResLike } from '../core/http.js';
import { featuredLiveSql } from '../ads/featured.js';
import { getSql } from '../core/db.js';
import { authenticate } from '../core/context.js';
import {
  reveals24h,
  vacancyContact,
  countVacancies,
  vacanciesFeed,
  vacancyDetail,
  savedFeed,
  parseFeedFilters,
  buildFilterWhere,
  encodeCursor,
  decodeCursor,
} from './read.js';

const VID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
interface FakeOpts {
  vacancyRow?: Row | null;
  adRow?: Row | null;
  alreadyRevealed?: boolean;
  revealCount?: number;
}

/** A tagged-template `sql` that records every call and routes canned rows by statement shape. */
function makeSql(opts: FakeOpts = {}) {
  const calls: { text: string; params: unknown[] }[] = [];
  const alreadyRows: Row[] = opts.alreadyRevealed ? [{ one: 1 }] : [];
  const fn = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<Row[]> => {
    const text = Array.isArray(strings) ? (strings as unknown as string[]).join('?') : String(strings);
    calls.push({ text, params });
    if (/contact_raw, contact_kind from vacancies/.test(text)) return Promise.resolve(opts.vacancyRow ? [opts.vacancyRow] : []);
    if (/contact_raw, contact_kind from user_ads/.test(text)) return Promise.resolve(opts.adRow ? [opts.adRow] : []);
    if (/\)::int as c/.test(text)) return Promise.resolve([{ c: opts.revealCount ?? 0 }]); // reveals24h
    if (/select 1\s+from contact_reveals/.test(text)) return Promise.resolve(alreadyRows);
    if (/select 1\s+from ad_contact_reveals/.test(text)) return Promise.resolve(alreadyRows);
    return Promise.resolve([]); // inserts + anything else
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { fn: fn as any, calls };
}

function makeReq(query: Record<string, string> = {}, method = 'GET'): ReqLike {
  return { method, headers: {}, query };
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
  vi.mocked(authenticate).mockResolvedValue({ ok: true, user: { id: 'user-1' } } as never);
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) reveals24h — the SHARED budget query
// ─────────────────────────────────────────────────────────────────────────────

describe('reveals24h — one budget summed across all three reveal tables', () => {
  it('sums contact_reveals + ad_contact_reveals + raw_contact_reveals over 24h, bound to the user 3×', async () => {
    const { fn, calls } = makeSql({ revealCount: 7 });
    const n = await reveals24h(fn, 'user-9');
    expect(n).toBe(7);
    expect(calls).toHaveLength(1);
    const { text, params } = calls[0]!;
    expect(text).toContain('contact_reveals');
    expect(text).toContain('ad_contact_reveals');
    expect(text).toContain('raw_contact_reveals');
    expect(text).toContain("interval '24 hours'");
    // the user id is a BOUND param in each of the three subqueries (never interpolated)
    expect(params).toEqual(['user-9', 'user-9', 'user-9']);
  });

  it('reports 0 when the count query yields no row', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const empty = ((..._a: unknown[]) => Promise.resolve([])) as any;
    expect(await reveals24h(empty, 'user-9')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) vacancyContact — cap + record + free repeat + race guard
// ─────────────────────────────────────────────────────────────────────────────

describe('vacancyContact — daily cap shared across tables, free repeat, race-safe insert', () => {
  it('first reveal under the cap: 200 + contact, checks the 3-table budget, records with an on-conflict guard', async () => {
    const { fn, calls } = makeSql({ vacancyRow: { contact_raw: '010-1234-5678', contact_kind: 'phone' }, revealCount: 0 });
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();
    await vacancyContact(makeReq({ id: VID }), res as unknown as ResLike);

    expect(res.statusCode).toBe(200);
    // reveals_left = cap(50) − (revealCount 0 + this reveal) = 49.
    expect(bodyOf(res)).toEqual({ contact: { kind: 'phone', value: '010-1234-5678' }, reveals_left: 49 });

    const budget = calls.find((c) => /\)::int as c/.test(c.text));
    expect(budget).toBeTruthy();
    expect(budget!.text).toContain('ad_contact_reveals');
    expect(budget!.text).toContain('raw_contact_reveals');

    const insert = calls.find((c) => /insert into contact_reveals/.test(c.text));
    expect(insert).toBeTruthy();
    expect(insert!.text).toContain('on conflict (user_id, vacancy_id) do nothing');
  });

  it('repeat reveal is FREE: no new row is inserted and it is never rate-limited (even over cap)', async () => {
    // revealCount 999 is way over the cap — but the already-revealed short-circuit must skip the insert
    // and the cap gate. The budget IS read now (to echo reveals_left), but it is never CHARGED (no insert).
    const { fn, calls } = makeSql({ vacancyRow: { contact_raw: 'x', contact_kind: 'phone' }, alreadyRevealed: true, revealCount: 999 });
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();
    await vacancyContact(makeReq({ id: VID }), res as unknown as ResLike);

    expect(res.statusCode).toBe(200); // never 429 for a repeat, even over cap
    expect(bodyOf(res)).toEqual({ contact: { kind: 'phone', value: 'x' }, reveals_left: 0 }); // max(0, 50−999)
    expect(calls.some((c) => /insert into contact_reveals/.test(c.text))).toBe(false); // no new row charged
  });

  it('at the cap: 429 rate_limited and NO reveal recorded', async () => {
    const { fn, calls } = makeSql({ vacancyRow: { contact_raw: 'x', contact_kind: 'phone' }, revealCount: 50 }); // == default cap
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();
    await vacancyContact(makeReq({ id: VID }), res as unknown as ResLike);

    expect(res.statusCode).toBe(429);
    expect(calls.some((c) => /insert into contact_reveals/.test(c.text))).toBe(false);
  });

  it('user-ad branch shares the SAME budget and records into ad_contact_reveals with its own conflict guard', async () => {
    const { fn, calls } = makeSql({ vacancyRow: null, adRow: { contact_raw: '@handle', contact_kind: 'telegram' }, revealCount: 0 });
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();
    await vacancyContact(makeReq({ id: VID }), res as unknown as ResLike);

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ contact: { kind: 'telegram', value: '@handle' }, reveals_left: 49 });
    expect(calls.some((c) => /\)::int as c/.test(c.text))).toBe(true); // same reveals24h gate
    const insert = calls.find((c) => /insert into ad_contact_reveals/.test(c.text));
    expect(insert!.text).toContain('on conflict (user_id, user_ad_id) do nothing');
  });

  it('contactless row does NOT burn a reveal (owner fix 2026-07-22): no insert, body {contact:null} + reveals_left', async () => {
    const { fn, calls } = makeSql({ vacancyRow: { contact_raw: null, contact_kind: null }, revealCount: 0 });
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();
    await vacancyContact(makeReq({ id: VID }), res as unknown as ResLike);

    expect(res.statusCode).toBe(200);
    // Budget untouched: reveals_left == full cap (50 − 0). The guard runs BEFORE any insert.
    expect(bodyOf(res)).toEqual({ contact: null, reveals_left: 50 });
    expect(calls.some((c) => /insert into contact_reveals/.test(c.text))).toBe(false); // NO reveal recorded
  });

  it('reveals_left = cap − reveals24h; a fresh reveal decrements the remaining by one', async () => {
    // 10 already used today → after THIS reveal 11 are used → 50 − 11 = 39 left.
    const { fn } = makeSql({ vacancyRow: { contact_raw: '010-0000-0000', contact_kind: 'phone' }, revealCount: 10 });
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();
    await vacancyContact(makeReq({ id: VID }), res as unknown as ResLike);
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).reveals_left).toBe(39);
  });

  it('404 when the id matches neither a visible vacancy nor an approved ad', async () => {
    const { fn } = makeSql({ vacancyRow: null, adRow: null });
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();
    await vacancyContact(makeReq({ id: VID }), res as unknown as ResLike);
    expect(res.statusCode).toBe(404);
  });

  it('404 (never a masking 200) for a missing / non-UUID id, without touching the DB', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();
    await vacancyContact(makeReq({ id: 'not-a-uuid' }), res as unknown as ResLike);
    expect(res.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('404 for a non-GET method', async () => {
    const res = makeRes();
    await vacancyContact(makeReq({ id: VID }, 'POST'), res as unknown as ResLike);
    expect(res.statusCode).toBe(404);
  });

  it('401 when initData does not authenticate', async () => {
    vi.mocked(authenticate).mockResolvedValueOnce({ ok: false } as never);
    const res = makeRes();
    await vacancyContact(makeReq({ id: VID }), res as unknown as ResLike);
    expect(res.statusCode).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (1) HIDE UNREACHABLE + persisted source_post_url (owner rule 2026-07-22, draft_0023)
//     Structural assertions on the generated UNION SQL — the fake `sql` records the query text.
// ─────────────────────────────────────────────────────────────────────────────

const HIDE = 'not (v.contact_normalized is null and v.source_post_url is null)';

describe('feed + count hide dead-end scraped offers and project the persisted link', () => {
  it('countVacancies: the counter SQL drops offers with neither a contact nor a stored link', async () => {
    const { fn, calls } = makeSql();
    const n = await countVacancies(fn, parseFeedFilters(makeReq({})));
    expect(n).toBe(0);
    const q = calls[0]!.text;
    expect(q).toContain('count(*)::int as c');
    expect(q).toContain(HIDE); // unreachable scraped rows excluded from the count
  });

  it('vacanciesFeed: the feed SQL hides dead ends AND projects source_post_url (scraped) / null (user ads)', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();
    await vacanciesFeed(makeReq({}), res as unknown as ResLike);

    expect(res.statusCode).toBe(200);
    // The feed's ORDER BY gained `f.featured desc` in front of the former keys (owner 2026-10-21),
    // so this matcher looks for the id of the feed query by its trailing keys.
    const feedCall = calls.find((c) => /order by .*f\.posted_at desc, f\.id desc/.test(c.text));
    expect(feedCall).toBeTruthy();
    const q = feedCall!.text;
    // Dead ends dropped from the feed union (scraped branch only).
    expect(q).toContain(HIDE);
    // Persisted column projected with the contact-less/city-less visibility gate...
    expect(q).toContain('then v.source_post_url else null end as source_post_url');
    // ...user ads carry null (no such column) so the UNION shapes line up...
    expect(q).toContain('null::text as source_post_url');
    // ...and the outer projection carries it out to the client.
    expect(q).toContain('f.source_post_url');
  });

  it('the hide applies ONLY to the scraped branch — a user ad is never gated on source_post_url', async () => {
    const { fn, calls } = makeSql();
    await countVacancies(fn, parseFeedFilters(makeReq({})));
    const q = calls[0]!.text;
    // The predicate references v.* (vacancies alias) only; the user_ads branch (alias a) is untouched.
    expect(q).toContain(HIDE);
    expect(q).not.toContain('not (a.contact_raw is null and a.source_post_url is null)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (1b) FEATURED placements (owner 2026-10-21, draft_0033) — WHERE the order changes and where it
//      must NOT. The ordering is SQL, and a fake `sql` cannot sort rows, so it is asserted as SQL
//      text; pretending to evaluate an ORDER BY would only prove the fake (same honesty rule as
//      notify/run.test.ts). The live proof lives in draft_0033's VERIFY/SANITY selects.
// ─────────────────────────────────────────────────────────────────────────────

const FEATURED_EXPR = "coalesce(((to_jsonb(a) ->> 'featured_until')::timestamptz) > now(), false)";
const FEED_ORDER = 'order by f.featured desc, f.posted_at desc, f.id desc';

describe('the FEED lifts live featured ads to the top — and nothing else changes order', () => {
  it('orders by featured first, then by the FORMER keys, byte-for-byte', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    const res = makeRes();
    await vacanciesFeed(makeReq({}), res as unknown as ResLike);

    const q = calls.find((c) => /order by f\.featured desc/.test(c.text))!.text;
    expect(q).toContain(FEED_ORDER);
    // The two trailing keys are untouched: two cards that are both featured (or both ordinary)
    // keep exactly the order they have today.
    expect(q).toContain('f.posted_at desc, f.id desc');
  });

  it('the week ENDS BY ITSELF: the flag is featured_until > now(), read through to_jsonb', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    await vacanciesFeed(makeReq({}), makeRes() as unknown as ResLike);
    const q = calls.find((c) => /order by f\.featured desc/.test(c.text))!.text;

    // One expression for the badge AND the ordering — and it is the module's own, not a copy.
    expect(q).toContain(`${featuredLiveSql('a')} as featured`);
    expect(featuredLiveSql('a')).toBe(FEATURED_EXPR);
    // A grant older than the week evaluates to false here: no sweep, no cron, no second flag.
    expect(q).toContain('> now()');
    // Never a bare column: a deploy before the migration must not break the app's main screen.
    expect(q).not.toMatch(/\ba\.featured_until\b/);
  });

  it('🔴 a vacancy from a CHANNEL is never featured (the lift is for ads placed through our form)', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    await vacanciesFeed(makeReq({}), makeRes() as unknown as ResLike);
    const q = calls.find((c) => /order by f\.featured desc/.test(c.text))!.text;

    // The scraped branch emits a literal false — there is no column to read and nothing to earn.
    expect(q).toContain('false as featured');
    expect(q).not.toMatch(/to_jsonb\(v\)/);
  });

  it('pages correctly: the cursor tuple carries the SAME elements as the ORDER BY', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    const cursor = encodeCursor('2026-10-20T10:00:00.000Z', '11111111-1111-1111-1111-111111111111', true);
    await vacanciesFeed(makeReq({ cursor }), makeRes() as unknown as ResLike);

    const call = calls.find((c) => /order by f\.featured desc/.test(c.text))!;
    expect(call.text).toContain('(f.featured, f.posted_at, f.id) <');
    expect(call.text).toContain('::boolean');
    // The flag travels as a BOUND param, like every other cursor element. (The feed is issued as
    // sql(text, params), so the fake records the whole param array as the first recorded arg.)
    expect(call.params[0]).toContain(true);
  });

  it('🔴 a PAID placement gets no lift: the ORDER BY does not mention promo at all', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    await vacanciesFeed(makeReq({}), makeRes() as unknown as ResLike);
    const q = calls.find((c) => /order by f\.featured desc/.test(c.text))!.text;

    // draft_0030's invariant, now a test and not a comment: paying may buy visibility in the
    // ordinary stream, never a position. The ONLY ranking key we added is `featured`.
    const orderBy = q.slice(q.indexOf('order by f.featured'));
    expect(orderBy).not.toContain('promo');
    expect(orderBy.split('\n')[0]!.trim()).toBe(FEED_ORDER);
    // promo is still projected (the card must still say «Реклама») — it just ranks nothing.
    expect(q).toContain("coalesce((to_jsonb(a) ->> 'promo')::boolean, false) as promo");
  });
});

describe('the COUNTER and the SAVED list keep their own order (they are not the feed)', () => {
  it('🔴 the counter has no ordering at all and still returns the same number', async () => {
    const { fn, calls } = makeSql({ revealCount: 42 });

    const n = await countVacancies(fn, parseFeedFilters(makeReq({})));

    expect(n).toBe(42); // the number the feed would show for these filters, unchanged by the lift
    const q = calls[0]!.text;
    expect(q).toContain('count(*)::int as c');
    expect(q).not.toContain('order by f.');
    expect(q).not.toContain('limit');
  });

  it('the saved list still sorts by WHEN YOU SAVED a card, not by the lift', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    await savedFeed(makeReq({}), makeRes() as unknown as ResLike);

    const q = calls.find((c) => /order by f\.saved_at desc/.test(c.text))!.text;
    expect(q).toContain('order by f.saved_at desc, f.id desc');
    expect(q).not.toContain('f.featured desc'); // a featured ad must not jump your own bookmarks
    // ...but the badge still shows on a bookmarked featured ad, so the flag IS projected.
    expect(q).toContain('f.featured');
    expect(q).toContain(`${featuredLiveSql('a')} as featured`);
  });

  it('the open card (detail) reads the flag with the SAME expression as the feed', async () => {
    const { fn, calls } = makeSql();
    vi.mocked(getSql).mockReturnValue(fn);
    await vacancyDetail(makeReq({ id: VID }), makeRes() as unknown as ResLike);

    const adQuery = calls.find((c) => /from user_ads a/.test(c.text))!;
    // Spelled out literally there (a tagged template turns an interpolation into a bound param),
    // so this is the parity guard between the two copies.
    expect(adQuery.text).toContain(`${FEATURED_EXPR} as featured`);
    expect(featuredLiveSql('a')).toBe(FEATURED_EXPR);
    const vacQuery = calls.find((c) => /from vacancies v/.test(c.text))!;
    expect(vacQuery.text).toContain('false as featured'); // a channel card, again, never featured
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) parseFeedFilters — CHARACTERIZATION of current parsing (snapshot, not a spec)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseFeedFilters — snapshot of current query parsing', () => {
  it('all defaults on an empty query', () => {
    expect(parseFeedFilters(makeReq({}))).toEqual({
      slugs: [],
      workTypes: [],
      regions: [],
      visa: [],
      paid: null,
      housing: false,
      meals: false,
      q: '',
      freshnessDays: null,
      noCity: true,
    });
  });

  it('cities CSV: trims each token and drops empties', () => {
    expect(parseFeedFilters(makeReq({ cities: ' seoul , busan , ,ansan ' })).slugs).toEqual(['seoul', 'busan', 'ansan']);
  });

  it('work_types are whitelisted against WORK_TYPES (unknowns dropped)', () => {
    expect(parseFeedFilters(makeReq({ work_types: 'factory,unicorn,food' })).workTypes).toEqual(['factory', 'food']);
  });

  it('visa is whitelisted against VISA_TYPES (unknowns dropped)', () => {
    expect(parseFeedFilters(makeReq({ visa: 'e9,dragon,any' })).visa).toEqual(['e9', 'any']);
  });

  it('paid accepts only free|paid, else null', () => {
    expect(parseFeedFilters(makeReq({ paid: 'free' })).paid).toBe('free');
    expect(parseFeedFilters(makeReq({ paid: 'paid' })).paid).toBe('paid');
    expect(parseFeedFilters(makeReq({ paid: 'whatever' })).paid).toBeNull();
    expect(parseFeedFilters(makeReq({})).paid).toBeNull();
  });

  it('housing/meals toggles are case-SENSITIVE "1"|"true" (note: "TRUE" is NOT accepted)', () => {
    expect(parseFeedFilters(makeReq({ housing: '1' })).housing).toBe(true);
    expect(parseFeedFilters(makeReq({ housing: 'true' })).housing).toBe(true);
    expect(parseFeedFilters(makeReq({ housing: '0' })).housing).toBe(false);
    expect(parseFeedFilters(makeReq({ housing: 'TRUE' })).housing).toBe(false); // characterization
    expect(parseFeedFilters(makeReq({ meals: 'true' })).meals).toBe(true);
  });

  it('q replaces dots with spaces and trims; falls back to keywords; q wins over keywords when present', () => {
    expect(parseFeedFilters(makeReq({ q: '  night.shift  ' })).q).toBe('night shift');
    expect(parseFeedFilters(makeReq({ keywords: '  cook  ' })).q).toBe('cook');
    expect(parseFeedFilters(makeReq({ q: 'a', keywords: 'b' })).q).toBe('a');
  });

  it('freshness is whitelisted to {1,3,7,14}, else null', () => {
    expect(parseFeedFilters(makeReq({ freshness: '7' })).freshnessDays).toBe(7);
    expect(parseFeedFilters(makeReq({ freshness: '1' })).freshnessDays).toBe(1);
    expect(parseFeedFilters(makeReq({ freshness: '2' })).freshnessDays).toBeNull();
    expect(parseFeedFilters(makeReq({ freshness: 'abc' })).freshnessDays).toBeNull();
    expect(parseFeedFilters(makeReq({})).freshnessDays).toBeNull();
  });

  it('no_city is true by default and only "0"/"false" turn it off', () => {
    expect(parseFeedFilters(makeReq({})).noCity).toBe(true);
    expect(parseFeedFilters(makeReq({ no_city: '1' })).noCity).toBe(true);
    expect(parseFeedFilters(makeReq({ no_city: 'yes' })).noCity).toBe(true);
    expect(parseFeedFilters(makeReq({ no_city: '0' })).noCity).toBe(false);
    expect(parseFeedFilters(makeReq({ no_city: 'false' })).noCity).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) buildFilterWhere — CHARACTERIZATION of placeholder/param assembly (snapshot)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildFilterWhere — snapshot of the parameterized WHERE', () => {
  it('default filters produce a 15-param positional binding in a fixed order', () => {
    const { where, params } = buildFilterWhere(parseFeedFilters(makeReq({})));
    expect(where).toContain('kj_geo_match');
    expect(where).toContain('make_interval');
    expect(where).toContain('$15'); // last placeholder assigned
    expect(params).toHaveLength(15);
    expect(params[0]).toEqual([]); // slugs
    expect(params[1]).toEqual([]); // regions
    expect(params[2]).toBe(true); // noCity
    expect(params[3]).toBe(true); // wtEmpty
    expect(params[4]).toEqual([]); // workTypes
    expect(params[5]).toBe(true); // visaEmpty
    expect(params[6]).toEqual([]); // visa
    expect(params[7]).toBe(true); // paidNull
    expect(params[8]).toBeNull(); // paid
    expect(params[9]).toBe(false); // housing
    expect(params[10]).toBe(false); // meals
    expect(params[11]).toBe(false); // hasQ
    expect(params[12]).toBe(''); // q
    expect(params[13]).toBe(true); // noFreshness
    expect(params[14]).toBe(0); // freshnessDays ?? 0
  });

  it('binds selected city slugs into the geo placeholder (whitelist happens in SQL against real cities)', () => {
    expect(buildFilterWhere(parseFeedFilters(makeReq({ cities: 'seoul,busan' }))).params[0]).toEqual(['seoul', 'busan']);
  });

  it('binds selected region slugs', () => {
    expect(buildFilterWhere(parseFeedFilters(makeReq({ regions: 'gyeonggi' }))).params[1]).toEqual(['gyeonggi']);
  });

  it('paid=free flips paidNull off and binds the value', () => {
    const { params } = buildFilterWhere(parseFeedFilters(makeReq({ paid: 'free' })));
    expect(params[7]).toBe(false);
    expect(params[8]).toBe('free');
  });

  it('housing on flips the strict has_housing clause and binds true', () => {
    const { where, params } = buildFilterWhere(parseFeedFilters(makeReq({ housing: '1' })));
    expect(params[9]).toBe(true);
    expect(where).toContain('f.has_housing is true');
  });

  it('a keyword flips hasQ and binds the cleaned query text', () => {
    const { params } = buildFilterWhere(parseFeedFilters(makeReq({ q: 'night.shift' })));
    expect(params[11]).toBe(true);
    expect(params[12]).toBe('night shift');
  });

  it('freshness=7 flips noFreshness off and binds the day count', () => {
    const { params } = buildFilterWhere(parseFeedFilters(makeReq({ freshness: '7' })));
    expect(params[13]).toBe(false);
    expect(params[14]).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) cursor — CHARACTERIZATION of encode/decode (snapshot)
// ─────────────────────────────────────────────────────────────────────────────

describe('encodeCursor / decodeCursor — snapshot of the base64url cursor', () => {
  const P = '2026-07-20T00:00:00.000Z';
  const I = '11111111-1111-1111-1111-111111111111';

  it('round-trips (posted_at, id) through a URL-safe base64 token', () => {
    const enc = encodeCursor(P, I);
    expect(enc).not.toMatch(/[+/=]/); // base64url, no padding / unsafe chars
    // `f` joined the cursor when the feed started ordering by (featured, posted_at, id) —
    // the ordering key and the cursor must carry the SAME elements or paging re-serves/skips rows.
    expect(decodeCursor(enc)).toEqual({ p: P, i: I, f: false });
  });

  it('carries the FEATURED flag of the last row, and an old cursor without it means "not featured"', () => {
    expect(decodeCursor(encodeCursor(P, I, true))).toEqual({ p: P, i: I, f: true });
    // A cursor minted before the feature (no `f` key at all) decodes to false — the safe side:
    // "we are already past the featured block", so page 2 cannot duplicate rows from page 1.
    const legacy = Buffer.from(JSON.stringify({ p: P, i: I }), 'utf8').toString('base64url');
    expect(decodeCursor(legacy)).toEqual({ p: P, i: I, f: false });
    // Nothing but a literal true counts as "in the featured block".
    const sneaky = Buffer.from(JSON.stringify({ p: P, i: I, f: 'true' }), 'utf8').toString('base64url');
    expect(decodeCursor(sneaky)).toEqual({ p: P, i: I, f: false });
  });

  it('an absent cursor decodes to null (first page)', () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('garbage decodes to null (bad cursor → first page, never a 500)', () => {
    expect(decodeCursor('!!!not-base64-json!!!')).toBeNull();
  });

  it('rejects a token whose id is not a UUID', () => {
    const bad = Buffer.from(JSON.stringify({ p: P, i: 'not-a-uuid' }), 'utf8').toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('rejects a token whose posted_at is not a real timestamp', () => {
    const bad = Buffer.from(JSON.stringify({ p: 'hello', i: I }), 'utf8').toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('rejects a token missing a field', () => {
    const bad = Buffer.from(JSON.stringify({ p: P }), 'utf8').toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
});
