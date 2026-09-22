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
    /**
     * When set, the acq_source failure above carries this string inside its message — the
     * way Postgres QUOTES the row it refused. Nothing but a leak can put it into a log
     * (guard №9, extended to door 1 by fix №5 of the third round).
     */
    dbErrorQuotes: '',
    /**
     * When true EVERY users-upsert throws — and it throws the message Postgres really
     * produces, which QUOTES the value it refused. That quoting is the whole point: it is
     * what turns a write fault into a telegram_id in the Vercel log (fix №5).
     */
    failUsersUpsert: false,
    /** config.acq_sources_allowed — the labels the owner approved (draft_0032). */
    allowed: ['ads_ru1', 'ads_ru2', 'ads_uz1', 'ads_uz2'] as string[],
  };
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    state.queries.push(q);
    state.values.push(values);
    if (state.failUsersUpsert && q.includes('insert into users')) {
      return Promise.reject(
        new Error(`invalid input syntax for type bigint: "${String(values[0])}"`),
      );
    }
    if (state.noAcqColumn && q.includes('acq_source')) {
      return Promise.reject(
        new Error(
          'column "acq_source" of relation "users" does not exist' +
            (state.dbErrorQuotes ? ` — failing row contains ("${state.dbErrorQuotes}")` : ''),
        ),
      );
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
import { mintHubSession } from './hub-session.js';
import { ACQ_SOURCE_APPHUB_SHELL } from './acq-source.js';
import type { ReqLike, ResLike } from './http.js';

const REF = 'a1b2c3d4e5f60718';
const VAC = '0f8c2a1b3d4e4f5a6b7c8d9e0f1a2b3c';

function req(): ReqLike {
  return { method: 'GET', headers: { authorization: 'tma user=%7B%22id%22%3A555%7D&hash=x' } };
}

/** A ticket id of the hub's shape — the pass carries it (hub-session.ts, invariant 7). */
const JTI = 'Zm9vYmFyYmF6cXV4MTIzNA';

/** A request through DOOR 2, carrying a REAL pass — hub-session is deliberately NOT mocked. */
function kjsReq(telegramId = '555', lang: string | null = null, jti = JTI): ReqLike {
  const { token } = mintHubSession(telegramId, lang, jti, process.env.BOT_TOKEN as string);
  return { method: 'GET', headers: { authorization: `kjs ${token}` } };
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
  h.state.dbErrorQuotes = '';
  h.state.failUsersUpsert = false;
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
        // A Telegram launch has no hub ticket, and "not said" stays "not known".
        hubJti: null,
      },
    });
  });
});

// ---------------------------------------------------------------------------------------
// DOOR 2: `Authorization: kjs <pass>` — the AppHub Studio shell.
//
// 🔴 THE RULE OF THIS BRANCH, IN ONE SENTENCE: a ticket brings ONE identity and NOT ONE
// profile field, so a login by ticket has no right to OVERWRITE anything in the profile.
// The Telegram door refreshes username/first_name/last_name on every launch because
// initData really carries them; a pass carries none of that, and reusing that upsert would
// write NULLs "on the ticket's authority" over a name the person already has.
//
// These are GUARDS, not descriptions: each one reddens if someone adds the tempting column
// back into ON CONFLICT. The pass itself is real (hub-session is not mocked) — only the DB
// and initData are fakes, as above.
// ---------------------------------------------------------------------------------------

/** The upsert statement up to (not including) its RETURNING clause. */
function writtenPart(): string {
  const q = upsert();
  const i = q.indexOf('returning');
  expect(i).toBeGreaterThan(-1);
  return q.slice(0, i);
}

/** ONLY the assignments of `do update set`. The RETURNING list names columns we READ. */
function conflictAssignments(): string {
  const branch = conflictBranch();
  const i = branch.indexOf('returning');
  return i === -1 ? branch : branch.slice(0, i);
}

describe('authenticate — door 2 (kjs pass) writes ONLY what a ticket actually proves', () => {
  it('lets a pass holder in and returns the same trusted row shape', async () => {
    const res = await authenticate(kjsReq('555', 'ru'));
    expect(res).toEqual({
      ok: true,
      user: {
        id: 'user-1',
        telegramId: '555',
        publicId: 'a1b2c3d4e5f60718',
        lang: 'ru',
        allowsWriteToPm: true,
        isBlocked: false,
        // 🔴 FIX №2: the ticket the session was born from, carried out to the boundary so
        // an incident can name it. The Telegram door returns null here.
        hubJti: JTI,
      },
    });
  });

  it('🔴 the jti travels ticket -> pass -> AuthedUser, unchanged (fix №2)', async () => {
    const other = 'QUJDREVGR0hJSktMTU5PUA';
    const res = await authenticate(kjsReq('555', null, other));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.user.hubJti).toBe(other);
  });

  it('🔴 its ON CONFLICT branch touches last_seen_at AND NOTHING ELSE', async () => {
    await authenticate(kjsReq());
    const branch = conflictAssignments();

    expect(branch).toContain('last_seen_at');
    // Add any of these to the update and a returning visitor loses the field — silently,
    // on a door nobody would think to connect it to.
    for (const column of ['username', 'first_name', 'last_name', 'lang', 'allows_write_to_pm']) {
      expect(branch, column).not.toContain(column);
    }
  });

  it('🔴 a person with allows_write_to_pm = true keeps it after signing in by pass', async () => {
    // The flag is a PERMISSION the person gave the bot inside Telegram. A ticket cannot
    // carry it (it exists only in Telegram's signature issued to a BOT), so this door must
    // not have an opinion about it at all — neither to raise nor to lower.
    const res = await authenticate(kjsReq());

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.user.allowsWriteToPm).toBe(true); // the fake row's stored value
    expect(writtenPart()).not.toContain('allows_write_to_pm');
  });

  it('🔴 the INSERT names telegram_id, lang and acq_source — nothing a ticket cannot prove', async () => {
    await authenticate(kjsReq());
    const columns = /insert into users \(([^)]*)\)/.exec(upsert())?.[1] ?? '';

    // acq_source is OUR OWN constant, not a profile field (see fix №12 below).
    expect(columns.split(',').map((c) => c.trim())).toEqual([
      'telegram_id',
      'lang',
      'acq_source',
    ]);
    // Listing a name column would insert NULL "signed by the ticket" — a NULL nobody proved.
    for (const column of ['username', 'first_name', 'last_name', 'allows_write_to_pm']) {
      expect(columns, column).not.toContain(column);
    }
  });

  it('🔴 the telegram_id reaches the upsert as an EXACT string, 19 digits included', async () => {
    const big = '9007199254740993'; // 2^53 + 1 — as a number it is someone else's account
    await authenticate(kjsReq(big));

    expect(h.state.values[0]).toContain(big);
    expect(JSON.stringify(h.state.values[0])).not.toContain('9007199254740992');
    // A string, never a number: the column is a bigint and the cast is ::bigint in SQL.
    expect(typeof (h.state.values[0] as unknown[])[0]).toBe('string');
  });

  it("the ticket's language is used on INSERT; without one the row falls back to 'ru'", async () => {
    await authenticate(kjsReq('555', 'uz'));
    expect(h.state.values[0]).toContain('uz');

    h.state.queries = [];
    h.state.values = [];
    await authenticate(kjsReq('555', null));
    expect(h.state.values[0]).toContain('ru');
  });

  it('a forged, tampered or expired pass gets nobody in — and writes NOTHING', async () => {
    const good = (kjsReq('555').headers.authorization as string).slice(4);
    const [v, body] = good.split('.');
    for (const bad of [`kjs ${v}.${body}.${'A'.repeat(43)}`, 'kjs nonsense', 'kjs 1.2.3']) {
      h.state.queries = [];
      const res = await authenticate({ method: 'GET', headers: { authorization: bad } });
      expect(res.ok, bad.slice(0, 16)).toBe(false);
      expect(h.state.queries, bad.slice(0, 16)).toHaveLength(0);
    }
  });
});

describe('authenticate — the two doors do not get mixed up', () => {
  it('🔴 a Telegram launch still runs ITS OWN upsert (the one that refreshes the profile)', async () => {
    await authenticate(req());
    const q = upsert();

    // The Telegram door's operator is unchanged: it does list the profile columns…
    expect(q).toContain('username');
    expect(q).toContain('first_name');
    // …and it does raise allows_write_to_pm, which door 2 must never do.
    expect(conflictBranch()).toContain('allows_write_to_pm');
  });

  it('🔴 a kjs request never goes through the Telegram path, even with initData mocked as valid', async () => {
    // verifyInitData is mocked to always succeed in this file, so if the branches were the
    // wrong way round this test would pass through the tma upsert and show it.
    await authenticate(kjsReq());
    expect(upsert()).not.toContain('username');
  });

  it('no Authorization header at all is still a refusal, through neither door', async () => {
    const res = await authenticate({ method: 'GET', headers: {} });
    expect(res.ok).toBe(false);
    expect(h.state.queries).toHaveLength(0);
  });
});

// =======================================================================================
// FIX №4 (Хейтер, major): THE "SAME RETURNING LIST" PROMISE GETS ITS COMPANION TEST.
//
// context.ts says in prose that door 2 RETURNs the same columns as the Telegram door. Until
// now that was only prose: the helpers above (writtenPart / conflictAssignments) CUT THE
// RETURNING TAIL OFF before asserting anything, so deleting a column from any one of the
// upserts reddened nothing at all. On the live system the shape of that mistake is: the next
// batch adds a column for a new gate to the Telegram RETURNING and forgets the kjs one — a
// shell guest then reads `undefined` where a boolean was expected, and the gate behaves
// differently on the second door, silently.
//
// So: cut the substring from 'returning' to the end out of EVERY users-upsert this file can
// produce and compare them letter by letter — plus pin the list itself, so removing a column
// from ALL of them at once does not slip through either.
// =======================================================================================

/** The `returning …` tail of every users-upsert issued so far, in call order. */
function returningTails(): string[] {
  return h.state.queries
    .filter((q) => q.includes('insert into users'))
    .map((q) => {
      const i = q.indexOf('returning');
      expect(i, 'a users upsert with no RETURNING at all').toBeGreaterThan(-1);
      return q.slice(i);
    });
}

describe('authenticate — both doors RETURN the same row, letter for letter (fix №4)', () => {
  const EXPECTED =
    'returning id, telegram_id, public_id, lang, allows_write_to_pm, is_blocked, visit_streak_day';

  it('🔴 every users-upsert in this file ends in the SAME returning clause', async () => {
    const tails: string[] = [];

    // 1. Telegram, plain launch.
    await authenticate(req());
    tails.push(...returningTails());

    // 2. Telegram, referral link (its own statement, with the CTE).
    h.state.queries = [];
    h.state.values = [];
    h.state.startParam = REF;
    await authenticate(req());
    tails.push(...returningTails());

    // 3. Telegram, campaign label.
    h.state.queries = [];
    h.state.values = [];
    h.state.startParam = 'ads_ru1';
    await authenticate(req());
    tails.push(...returningTails());

    // 4. Door 2 — and 5, its label-less fallback (two statements in one call).
    h.state.queries = [];
    h.state.values = [];
    h.state.startParam = '';
    h.state.noAcqColumn = true;
    await authenticate(kjsReq());
    tails.push(...returningTails());

    // Five statements, six executions — and exactly ONE distinct returning clause.
    expect(tails.length).toBeGreaterThanOrEqual(5);
    expect([...new Set(tails)]).toEqual([EXPECTED]);
  });

  it('🔴 and that clause is the full list — dropping a column from ALL of them reddens too', async () => {
    // Equality alone would survive a column being deleted everywhere at once. This is the
    // second half: the columns the callers actually read, named out loud.
    await authenticate(kjsReq());
    const [tail] = returningTails();
    expect(tail).toBe(EXPECTED);
    for (const column of [
      'id',
      'telegram_id',
      'public_id',
      'lang',
      'allows_write_to_pm',
      'is_blocked',
      'visit_streak_day',
    ]) {
      expect(tail, column).toContain(column);
    }
  });
});

// =======================================================================================
// FIX №12 (Хейтер, minor): THE SECOND DOOR IS MEASURABLE.
// A month from now the owner asks "did the second door bring anybody at all". Origin is
// proved cryptographically here (the hub's signature on aud='korea_jobs'), so the answer
// costs one constant in the INSERT — and must NOT go through the allow-list, which exists
// to judge a STRANGER's text out of a public ?startapp=, not our own constant.
// =======================================================================================
describe('authenticate — door 2 records where it came from (fix №12)', () => {
  it('🔴 acq_source is in the INSERT list and NOT in ON CONFLICT', async () => {
    await authenticate(kjsReq());
    expect(upsert()).toMatch(/insert into users \([^)]*acq_source/);
    // A returning visitor must never have their origin rewritten — and an account that
    // already existed was not acquired by the shell at all.
    expect(conflictAssignments()).not.toContain('acq_source');
  });

  it('the value is our constant, and it travels BOUND, never inside the statement text', async () => {
    await authenticate(kjsReq());
    expect(ACQ_SOURCE_APPHUB_SHELL).toBe('apphub_shell');
    expect(h.state.values[0]).toContain(ACQ_SOURCE_APPHUB_SHELL);
    expect(upsert()).not.toContain('apphub_shell');
  });

  it('🔴 the allow-list does NOT gate it — an EMPTY list still records the origin', async () => {
    // The list answers "did the owner approve this stranger's string?". This is not a
    // stranger's string. Running it through the gate would mean the owner has to approve a
    // label he cannot even type, and door 2 would silently count nobody.
    h.state.allowed = [];
    const res = await authenticate(kjsReq());

    expect(res.ok).toBe(true);
    expect(h.state.values[0]).toContain(ACQ_SOURCE_APPHUB_SHELL);
    // …and nothing is counted as "a label missed the list" either: nothing was judged.
    expect(rejectCounted()).toBe(false);
  });

  it('SURVIVES the deploy-before-migrate window: falls back, and the person still gets in', async () => {
    h.state.noAcqColumn = true;
    const res = await authenticate(kjsReq());

    expect(res.ok).toBe(true);
    const inserts = h.state.queries.filter((q) => q.includes('insert into users'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toContain('acq_source');
    expect(inserts[1]).not.toContain('acq_source');
  });
});

// =======================================================================================
// FIX №5 (Хейтер), second half: A WRITE FAULT ON DOOR 2 IS AN HONEST REFUSAL, NOT A 500
// CARRYING A STACK. The kjs upsert used to be un-guarded, so anything Postgres refused
// travelled up as the cause of a 500 — and api/index.ts prints cause.message + stack, while
// a Postgres message QUOTES the value it refused. The telegram_id would land in the Vercel
// log, once per request.
// =======================================================================================
describe('authenticate — door 2 write faults leak nothing (fix №5)', () => {
  it('🔴 both statements failing -> OUR OWN error, and not one character of the DB error', async () => {
    const SUB = '761543098761';
    h.state.failUsersUpsert = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Since fix №2 of the third round this is a THROW, not `{ ok: false }` — see the
      // block below for why a 401 was the wrong answer. What has not changed, and is the
      // whole of fix №5: what escapes is a sentence WE wrote.
      await expect(authenticate(kjsReq(SUB))).rejects.toThrow('kjs upsert failed');

      const printed = err.mock.calls.flat().map(String).join('\n');
      // It does say that something failed, and where…
      expect(printed).toContain('[auth] kjs upsert failed');
      // …and nothing else: not the id, not the driver's message that quotes it, no stack.
      expect(printed).not.toContain(SUB);
      expect(printed).not.toContain('invalid input syntax');
      expect(printed).not.toContain('bigint');
      expect(printed).not.toContain('at Object.');
    } finally {
      err.mockRestore();
    }
  });

  it('a fault in the FIRST statement only is not a refusal at all — the fallback carries it', async () => {
    h.state.noAcqColumn = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await authenticate(kjsReq('761543098761'));
      expect(res.ok).toBe(true);
      expect(err.mock.calls.flat().map(String).join('\n')).not.toContain('761543098761');
    } finally {
      err.mockRestore();
    }
  });
});

// =======================================================================================
// FIX №2 OF THE THIRD ROUND (007, major): A BLINKING DATABASE MUST NOT READ AS A BROKEN
// PASS. While the failure of both upserts returned { ok: false }, the handler answered 401
// and the shell drew «этот вход больше не работает, вернись в AppHub Studio и открой
// заново». The person goes back, the shell mints a fresh ticket, the exchange SUCCEEDS
// (POST /api/auth/hub never touches the database) — and the very next request is 401 again.
// A loop in which the fault is assigned to the person, over an outage this project has
// actually had. Door 1 in the same situation falls honestly into 500.
//
// Driven THROUGH THE ROUTER, because the number in question is what a person's client
// receives, not what an internal function returns (and 401 vs 500 is precisely the
// difference between "your entrance is dead" and "the service is down for a minute").
// =======================================================================================
describe('door 2 — a database fault answers 500, never 401 (fix №2)', () => {
  it('🔴 a VALID pass + a dead database -> 500 with an errorId, and no DB text in the log', async () => {
    const SUB = '761543098761';
    h.state.failUsersUpsert = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The real router, with the same mocked db.js this file already uses.
      const { default: router } = await import('../../../api/index.js');
      const res = {
        statusCode: 0,
        body: '',
        headers: {} as Record<string, string>,
        setHeader(n: string, v: string) {
          this.headers[n] = v;
        },
        end(b: string) {
          this.body = b;
        },
      };
      const { token } = mintHubSession(SUB, null, JTI, process.env.BOT_TOKEN as string);
      await router(
        {
          method: 'GET',
          headers: { authorization: `kjs ${token}` },
          query: { path: 'me' },
        } as ReqLike,
        res as unknown as ResLike,
      );

      // 🔴 THE NUMBER THE PERSON'S CLIENT SEES.
      expect(res.statusCode).toBe(500);
      expect(res.statusCode).not.toBe(401);
      const body = JSON.parse(res.body) as { errorId?: unknown };
      expect(typeof body.errorId).toBe('string'); // quotable, and the same id is in the log

      const printed = err.mock.calls.flat().map(String).join('\n');
      // What escaped is OUR sentence — that is what makes the 500 safe to log in full.
      expect(printed).toContain('kjs upsert failed');
      // And not one character of the driver's message, which quotes what it refused.
      expect(printed).not.toContain(SUB);
      expect(printed).not.toContain('invalid input syntax');
    } finally {
      err.mockRestore();
    }
  });
});

// =======================================================================================
// FIX №5 OF THE THIRD ROUND (007, minor): THE SAME LEAK WAS STILL SITTING ON DOOR 1.
// GUARD №9 ("the log carries no secrets"), written for the hub door in auth/hub.test.ts,
// now covers the Telegram door too: its acq_source fallback printed err.message, and a
// Postgres message QUOTES the value it refused — the telegram_id bound three lines above.
// The DB error is supplied by the mock, quoting a value that exists nowhere else.
//
// Only the LOG LINE changed on this door: the entry logic, the upsert and its own tests are
// untouched (the fallback still happens, and the person still gets in — asserted here).
// =======================================================================================
describe('authenticate — door 1 write faults leak nothing either (fix №5, guard №9 extended)', () => {
  /** A value that appears nowhere else in this file, so a hit is a real hit. */
  const QUOTED = 'tg-761543098761-and-a-label';

  it('🔴 the acq_source fallback prints the FACT and the PLACE, never the driver message', async () => {
    h.state.startParam = 'ads_ru1';
    h.state.noAcqColumn = true;
    h.state.dbErrorQuotes = QUOTED; // Postgres quoting the row it refused
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await authenticate(req());

      // Door 1 behaves exactly as before: the fallback runs and the person gets in.
      expect(res.ok).toBe(true);

      const printed = err.mock.calls.flat().map(String).join('\n');
      // It says that something failed and where — silence would be the other failure.
      expect(printed).toContain('[auth] acq_source upsert failed');
      // …and nothing of the error itself.
      expect(printed).not.toContain(QUOTED);
      expect(printed).not.toContain('does not exist');
      expect(printed).not.toContain('relation "users"');
    } finally {
      err.mockRestore();
    }
  });
});
