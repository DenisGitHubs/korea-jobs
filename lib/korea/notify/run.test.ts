// lib/korea/notify/run.test.ts
//
// runNotify — the PER-USER DAILY CAP (owner, 2026-07-26). The DB is a fake tagged-template `sql`
// routed by statement shape, the Bot API is a spy, so the whole run is exercised without a database.
//
// What is pinned here:
//   * a subscriber who has NOT used up their daily budget still gets their DM (nothing regressed);
//   * a subscriber AT their cap gets NO DM, and their offers are closed with status 'skipped' +
//     error 'daily_cap' — the row is what stops one capped person from freezing the queue for
//     everyone else (vacSubs' `not exists` skips them, so notify_pending can retire);
//   * cap NULL = NO LIMIT — the pre-cap behaviour EVERY subscription keeps (old and brand-new
//     alike) until its owner picks a number in the settings;
//   * the budgets are fetched with ONE grouped query per run (no N+1), over Asia/Seoul midnight and
//     counting DISTINCT tg_message_id (LETTERS), not notifications_sent rows (offers);
//   * any fault in that lookup fails OPEN (mail keeps flowing uncapped), never closed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type Call = { text: string; params: unknown[] };

const VAC_ID = '11111111-1111-1111-1111-111111111111';
const AD_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const h = vi.hoisted(() => {
  const state = {
    vacs: [] as Row[],
    ads: [] as Row[],
    subs: [] as Row[],
    budgets: [] as Row[],
    budgetsThrow: false,
    leaseHeld: false, // true = another run holds the single-flight lease (the claim returns no row)
    subsCalls: 0,
    matchCalls: 0, // how many subscriber lookups belong to the MATCH phase (step 2)
    calls: [] as Call[],
    // Every sendMessage ATTEMPT (recorded before the reply, so a call that throws is still here).
    sent: [] as { chatId: number | string; text: string; extra: Record<string, unknown> }[],
    // Scripted Bot API replies per chat id, consumed in order; none left = ok. 'throw' = the call throws.
    replies: {} as Record<string, (Row | 'throw')[]>,
    // config 'notify_note_given' as the "database" holds it (survives between runs of one test).
    noteGiven: null as unknown,
    noteGivenReadThrows: false, // the read of 'notify_note_given' fails (connection reset)
    recordSentThrows: 0, // how many upcoming 'sent' INSERTs into notifications_sent fail
  };
  const fakeSql = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<Row[]> => {
    const text = typeof strings === 'string' ? strings : (strings as unknown as string[]).join('?');
    state.calls.push({ text, params });

    // Single-flight lease claim (insert into config … returning true as claimed).
    if (/insert into config/.test(text) && params.includes('notify_run_lease')) {
      return Promise.resolve(state.leaseHeld ? [] : [{ claimed: true }]);
    }
    if (/select value from config/.test(text) && params.includes('notify_note_given')) {
      if (state.noteGivenReadThrows) return Promise.reject(new Error('connection reset'));
      return Promise.resolve(state.noteGiven === null ? [] : [{ value: state.noteGiven }]);
    }
    if (/insert into config/.test(text) && params.includes('notify_note_given')) {
      state.noteGiven = JSON.parse(params[1] as string);
      return Promise.resolve([]);
    }
    if (/insert into notifications_sent/.test(text) && /'sent'/.test(text) && state.recordSentThrows > 0) {
      state.recordSentThrows -= 1;
      return Promise.reject(new Error('connection reset'));
    }
    // The daily-budget lookup is the only statement that reads the cap via to_jsonb.
    if (/to_jsonb\(s\)/.test(text)) {
      if (state.budgetsThrow) return Promise.reject(new Error('column "notify_daily_cap" does not exist'));
      return Promise.resolve(state.budgets);
    }
    if (/from vacancies v/.test(text)) return Promise.resolve(state.vacs);
    if (/from user_ads a/.test(text)) return Promise.resolve(state.ads);
    if (/from subscriptions s join users u/.test(text)) {
      state.subsCalls += 1;
      // Step 2 asks once per fetched item; step 4 re-asks to decide whether notify_pending retires.
      return Promise.resolve(state.subsCalls <= state.matchCalls ? state.subs : []);
    }
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('../config.js', () => ({
  getConfigBool: vi.fn(async (_k: string, fallback: boolean) => fallback),
  getConfigNumber: vi.fn(async (_k: string, fallback: number) => fallback),
}));
vi.mock('../bot/telegram.js', () => ({
  sendMessage: (chatId: number | string, text: string, extra: Record<string, unknown> = {}) => {
    h.state.sent.push({ chatId, text, extra });
    const next = h.state.replies[String(chatId)]?.shift();
    if (next === 'throw') return Promise.reject(new Error('The operation was aborted due to timeout'));
    return Promise.resolve(next ?? { ok: true, result: { message_id: 777 } });
  },
  // Bot API meaning, written here from the documented reply shape (not imported from the code):
  // 403 = the person blocked the bot / never started it; 429 = parameters.retry_after seconds.
  isUserUnavailable: (r: Row) => r.ok === false && r.error_code === 403,
  retryAfterSeconds: (r: Row) =>
    r.ok === false && r.error_code === 429
      ? ((r.parameters as { retry_after?: number } | undefined)?.retry_after ?? null)
      : null,
}));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runNotify,
  NOTIFY_LEASE_SECONDS,
  NOTIFY_RATE_LIMIT_SLEEP_MAX_SECONDS,
  rateLimitSleepMs,
  seoulDay,
  type NotifyResult,
} from './run.js';
import { NOTIFY_LAST_LETTER_NOTE } from './cap.js';

const vacancyRow = (id = VAC_ID): Row => ({
  id,
  work_type: 'factory',
  city_id: null,
  city_ids: ['33333333-3333-3333-3333-333333333333'],
  region_slugs: [],
  city_name: { ru: 'Ансан', ko: '안산', en: 'Ansan' },
  salary_text: '2 500 000 KRW',
  visa_types: [],
  placement_fee: 'none',
  has_housing: true,
  has_meals: null,
});

const adRow = (id = AD_ID): Row => ({ ...vacancyRow(id), author_user_id: null });

/** Every notifications_sent INSERT this run performed, with its bound params. */
const notifInserts = () => h.state.calls.filter((c) => /insert into notifications_sent/.test(c.text));
const cappedInserts = () => notifInserts().filter((c) => c.params.includes('daily_cap'));
const budgetQueries = () => h.state.calls.filter((c) => /to_jsonb\(s\)/.test(c.text));

beforeEach(() => {
  h.state.vacs = [vacancyRow()];
  h.state.ads = [];
  h.state.subs = [{ user_id: USER_ID, telegram_id: '555' }];
  h.state.budgets = [];
  h.state.budgetsThrow = false;
  h.state.leaseHeld = false;
  h.state.subsCalls = 0;
  h.state.matchCalls = 1; // one vacancy fetched -> one match lookup in step 2
  h.state.calls = [];
  h.state.sent = [];
  h.state.replies = {};
  h.state.noteGiven = null;
  h.state.noteGivenReadThrows = false;
  h.state.recordSentThrows = 0;
  process.env.APP_URL = 'https://app.example.com';
});

describe('runNotify — under the daily cap', () => {
  it('sends the DM when the user has letters left today', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 10, letters: 3 }];

    const r = await runNotify();

    expect(h.state.sent).toHaveLength(1);
    expect(r.sent).toBe(1);
    expect(r.capped).toBe(0);
    expect(cappedInserts()).toHaveLength(0);
  });

  it('the very last allowed letter (cap-1 already sent) still goes out', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 4 }];

    const r = await runNotify();

    expect(r.sent).toBe(1);
    expect(r.capped).toBe(0);
  });
});

describe('runNotify — at the daily cap', () => {
  it('sends NOTHING and closes the offers with status skipped / error daily_cap', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 5 }];

    const r = await runNotify();

    expect(h.state.sent).toHaveLength(0); // not a single Bot API call for this person
    expect(r.sent).toBe(0);
    expect(r.capped).toBe(1);

    // The offer is recorded as skipped-for-cap, NOT as sent: `not exists` in the subscriber match
    // now excludes this user, so notify_pending can retire and the batch keeps draining. Without
    // that row the oldest offers would sit in the queue forever and mute EVERYONE else.
    const capped = cappedInserts();
    expect(capped).toHaveLength(1);
    expect(capped[0]!.text).toContain("'skipped'");
    expect(capped[0]!.params).toEqual([USER_ID, VAC_ID, 'daily_cap']);
    // ...and nothing was recorded as delivered.
    expect(notifInserts().some((c) => /'sent'/.test(c.text))).toBe(false);
  });

  it('closes EVERY offer matched this tick for that user, vacancies and ads alike', async () => {
    h.state.vacs = [vacancyRow()];
    h.state.ads = [adRow()];
    h.state.matchCalls = 2; // one vacancy + one ad
    h.state.budgets = [{ user_id: USER_ID, cap: 1, letters: 1 }];

    const r = await runNotify();

    expect(r.capped).toBe(1);
    expect(h.state.sent).toHaveLength(0);
    expect(cappedInserts()).toHaveLength(2);
    expect(cappedInserts().map((c) => c.params[1])).toEqual([VAC_ID, AD_ID]);
  });

  it('a cap lowered below what was already sent today still blocks (no negative budget)', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 40 }];

    const r = await runNotify();

    expect(h.state.sent).toHaveLength(0);
    expect(r.capped).toBe(1);
  });
});

describe('runNotify — NO limit (cap NULL) is the untouched pre-cap behaviour', () => {
  it('cap NULL (the explicit «Без ограничения» choice) is never limited', async () => {
    // Since 2026-10-24 a new row starts at 10 (subscriptions/rw.ts); NULL is what a person who chose
    // «Без ограничения» holds — this run must send to them, never skip.
    h.state.budgets = [{ user_id: USER_ID, cap: null, letters: 0 }];

    const r = await runNotify();

    expect(h.state.sent).toHaveLength(1);
    expect(r.sent).toBe(1);
    expect(r.capped).toBe(0);
    expect(cappedInserts()).toHaveLength(0);
  });

  it('delivers however many letters the user already had today', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: null, letters: 77 }]; // the live 19.07 peak

    const r = await runNotify();

    expect(h.state.sent).toHaveLength(1);
    expect(r.sent).toBe(1);
    expect(r.capped).toBe(0);
    expect(cappedInserts()).toHaveLength(0);
  });

  it('a user with no row in the budget lookup at all is treated as unlimited', async () => {
    h.state.budgets = [];

    const r = await runNotify();

    expect(r.sent).toBe(1);
    expect(r.capped).toBe(0);
  });
});

describe('runNotify — the budget lookup itself', () => {
  it('runs ONCE per run (one grouped query for all candidates, never N+1)', async () => {
    h.state.vacs = [vacancyRow(), vacancyRow('44444444-4444-4444-4444-444444444444')];
    h.state.matchCalls = 2;
    h.state.budgets = [{ user_id: USER_ID, cap: 10, letters: 0 }];

    await runNotify();

    expect(budgetQueries()).toHaveLength(1);
  });

  it('counts LETTERS (distinct tg_message_id) over the Asia/Seoul day, not notification rows', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 10, letters: 0 }];

    await runNotify();

    const q = budgetQueries()[0]!.text;
    expect(q).toContain('count(distinct tg_message_id)');
    expect(q).toContain("date_trunc('day', now() at time zone 'Asia/Seoul')");
    expect(q).toContain("status = 'sent'"); // failed / skipped deliveries never eat the budget
  });

  it('FAILS OPEN: a broken lookup (e.g. migration not applied) keeps mail flowing uncapped', async () => {
    h.state.budgetsThrow = true;

    const r = await runNotify();

    expect(h.state.sent).toHaveLength(1);
    expect(r.sent).toBe(1);
    expect(r.capped).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PAID PLACEMENTS (draft_0030) — the guard that must never bend
// ─────────────────────────────────────────────────────────────────────────────
//
// A promo ad is a FEED-ONLY object: selling visibility is allowed, mailing a paid ad into people's
// private messages is not. The ban lives in four independent places (parser -> store -> publisher ->
// here). The publisher half is pinned in scheduled/run.test.ts (promo is written with
// notify_pending=false); the half that belongs to THIS worker is SQL, so it is asserted as SQL —
// the fake `sql` cannot evaluate a WHERE clause, and a test that pretended otherwise would prove
// nothing.
describe('runNotify — a promo ad is never pushed to anybody', () => {
  it('excludes promo rows from the batch it fetches', async () => {
    await runNotify();

    const adFetch = h.state.calls.find((c) => /from user_ads a/.test(c.text))!;
    expect(adFetch.text).toContain("to_jsonb(a) ->> 'promo'");
    expect(adFetch.text).toContain('not coalesce');
  });

  it('clears notify_pending on a promo row instead of rescanning it every tick', async () => {
    await runNotify();

    const clear = h.state.calls.find(
      (c) => /update user_ads set notify_pending = false/.test(c.text) && /promo/.test(c.text),
    );
    expect(clear).toBeDefined();
  });

  it('reads the flag through to_jsonb, so a database without draft_0030 still works', async () => {
    await runNotify();

    const adFetch = h.state.calls.find((c) => /from user_ads a/.test(c.text))!;
    // No bare `a.promo` anywhere: naming a not-yet-migrated column would break the whole worker.
    expect(adFetch.text).not.toMatch(/\ba\.promo\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LAST LETTER OF THE DAY (owner, 2026-10-24): «вместе с последним письмом по лимиту пиши, что можно
// увеличить лимит в приложении». The N-th of N letters carries the note at its END, separated by an
// empty line; the (N-1)-th does not; NULL (no limit) never does; a person already at the cap gets no
// letter and therefore no note — never a separate message.
// ─────────────────────────────────────────────────────────────────────────────
describe('runNotify — the last letter of the day carries the note', () => {
  it('the N-th of N letters ends with an empty line + the note', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 4 }];

    await runNotify();

    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]!.text.endsWith(`\n\n${NOTIFY_LAST_LETTER_NOTE}`)).toBe(true);
    // the letter itself is still there in front of it
    expect(h.state.sent[0]!.text.startsWith('Новая вакансия:')).toBe(true);
  });

  it('the (N-1)-th letter does NOT carry it', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 3 }];

    await runNotify();

    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]!.text).not.toContain(NOTIFY_LAST_LETTER_NOTE);
  });

  it('cap = 1: the only letter of the day carries it', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 1, letters: 0 }];

    await runNotify();

    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]!.text).toContain(NOTIFY_LAST_LETTER_NOTE);
  });

  it('no limit (cap NULL) never gets it, however many letters were sent', async () => {
    for (const letters of [0, 9, 10, 77]) {
      h.state.sent = [];
      h.state.calls = [];
      h.state.subsCalls = 0;
      h.state.budgets = [{ user_id: USER_ID, cap: null, letters }];

      await runNotify();

      expect(h.state.sent).toHaveLength(1);
      expect(h.state.sent[0]!.text, `letters=${letters}`).not.toContain(NOTIFY_LAST_LETTER_NOTE);
    }
  });

  it('already at the cap before the run: no letter at all, and no separate note', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 5 }];

    await runNotify();

    expect(h.state.sent).toHaveLength(0);
  });

  it('a grouped letter (several offers) gets the note in its text, buttons untouched', async () => {
    h.state.vacs = [vacancyRow(), vacancyRow('44444444-4444-4444-4444-444444444444')];
    h.state.matchCalls = 2;
    h.state.budgets = [{ user_id: USER_ID, cap: 10, letters: 9 }];

    await runNotify();

    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]!.text).toBe(`Новые вакансии: 2\n\n${NOTIFY_LAST_LETTER_NOTE}`);
    const kb = (h.state.sent[0]!.extra.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
    expect(kb).toHaveLength(2);
  });

  it('plain text: the run sets no parse_mode, so nothing in the note is read as markup', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 4 }];

    await runNotify();

    expect(h.state.sent[0]!.extra).not.toHaveProperty('parse_mode');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE-FLIGHT: two overlapping runs (the tick + POST /api/cron/notify) must not both send the N-th
// letter — that would exceed the cap and deliver the note twice. The second run finds the lease held
// and does NOTHING (everything stays pending for the next tick).
// ─────────────────────────────────────────────────────────────────────────────
describe('runNotify — a second, overlapping run does nothing', () => {
  it('lease held by another run: no letter, no note, no record, nothing retired', async () => {
    h.state.leaseHeld = true;
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 4 }];

    const r = await runNotify();

    expect(r).toEqual({ vacancies: 0, ads: 0, sent: 0, capped: 0, busy: true });
    expect(h.state.sent).toHaveLength(0);
    expect(notifInserts()).toHaveLength(0);
    expect(budgetQueries()).toHaveLength(0); // it never even read the budgets
    expect(h.state.calls.some((c) => /notify_pending = false/.test(c.text))).toBe(false);
  });

  it('two runs back to back: the first sends the last letter, the second (lease held) adds nothing', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 4 }];
    await runNotify(); // run A: holds the lease while it sends
    expect(h.state.sent).toHaveLength(1);

    h.state.leaseHeld = true; // run B overlaps run A
    h.state.subsCalls = 0;
    const b = await runNotify();

    expect(b.busy).toBe(true);
    expect(h.state.sent).toHaveLength(1); // still ONE letter, ONE note
    expect(h.state.sent.filter((s) => s.text.includes(NOTIFY_LAST_LETTER_NOTE))).toHaveLength(1);
  });

  it('the claim is atomic and expiring; the release frees only this run’s own lease', async () => {
    await runNotify();

    const claim = h.state.calls.find((c) => /insert into config/.test(c.text))!;
    expect(claim.text).toContain('on conflict (key) do update');
    expect(claim.text).toContain("(config.value ->> 'at')::double precision");
    expect(claim.params).toContain(NOTIFY_LEASE_SECONDS);
    expect(claim.text).toContain('returning true as claimed');
    const runId = claim.params[1];

    const release = h.state.calls.find((c) => /update config set value/.test(c.text))!;
    expect(release).toBeDefined();
    expect(release.text).toContain("config.value ->> 'run' =");
    expect(release.params).toContain(runId);
    // and it is the LAST statement of the run (released after everything, incl. step 4)
    expect(h.state.calls[h.state.calls.length - 1]).toBe(release);
  });

  it('the lease is released even when the run throws', async () => {
    h.state.vacs = null as unknown as Row[]; // make step 2 blow up
    await expect(runNotify()).rejects.toThrow();

    expect(h.state.calls.some((c) => /update config set value/.test(c.text))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A FAILED SEND (wave 2, 2026-10-24). {ok:false} = the letter definitely did NOT go out; a call that
// THROWS (timeout 8 s, network) = it MAY have gone out. Neither may end the run for the people after;
// the last-letter line must reach a person once, and must not be lost when the letter was not sent.
// ─────────────────────────────────────────────────────────────────────────────

const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const VAC_2 = '44444444-4444-4444-4444-444444444444';

/** Run on a fake setTimeout: the 40 ms gaps and 429 pauses cost no real time; reports fake ms spent. */
async function runOnFakeClock(limitMs = 20_000): Promise<{
  result?: NotifyResult;
  error?: unknown;
  done: boolean;
  elapsedMs: number;
}> {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  try {
    const out: { result?: NotifyResult; error?: unknown; done: boolean; elapsedMs: number } = {
      done: false,
      elapsedMs: 0,
    };
    runNotify().then(
      (r) => Object.assign(out, { result: r, done: true }),
      (e: unknown) => Object.assign(out, { error: e, done: true }),
    );
    await vi.advanceTimersByTimeAsync(0);
    while (!out.done && out.elapsedMs < limitMs) {
      await vi.advanceTimersByTimeAsync(50);
      out.elapsedMs += 50;
    }
    return out;
  } finally {
    vi.useRealTimers();
  }
}

/** The second run of a test: step 2 matches again (the fake re-arms by the lookup counter). */
const nextRun = (): void => {
  h.state.subsCalls = 0;
};
const noteGivenWrites = () =>
  h.state.calls.filter((c) => /insert into config/.test(c.text) && c.params.includes('notify_note_given'));
const noteGivenReads = () =>
  h.state.calls.filter((c) => /select value from config/.test(c.text) && c.params.includes('notify_note_given'));

describe('runNotify — the N-th letter did NOT go out: the next run carries the line', () => {
  const notSent: [string, Row][] = [
    ['ok:false (a Bot API error)', { ok: false, error_code: 500, description: 'Internal Server Error' }],
    ['429 (rate limit)', { ok: false, error_code: 429, parameters: { retry_after: 0 } }],
  ];
  for (const [name, reply] of notSent) {
    it(name, async () => {
      h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 4 }];
      h.state.replies['555'] = [reply];

      const a = await runOnFakeClock();
      expect(a.done).toBe(true);
      expect(a.error).toBeUndefined();
      expect(a.result!.sent).toBe(0);
      expect(notifInserts()).toHaveLength(0); // nothing recorded -> still 4 letters today
      expect(noteGivenWrites()).toHaveLength(0); // definitely not delivered -> nobody marked

      nextRun();
      const b = await runOnFakeClock();
      expect(b.result!.sent).toBe(1);
      expect(h.state.sent).toHaveLength(2);
      expect(h.state.sent[1]!.text.endsWith(`\n\n${NOTIFY_LAST_LETTER_NOTE}`)).toBe(true);
    });
  }

  it('403: the person is marked blocked, the offers closed as skipped, nobody marked for the line', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 4 }];
    h.state.replies['555'] = [{ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }];

    const r = await runOnFakeClock();

    expect(r.result!.sent).toBe(0);
    const blocked = h.state.calls.filter((c) => /update users set is_blocked = true/.test(c.text));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.params).toEqual([USER_ID]);
    const skipped = notifInserts();
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.text).toContain("'skipped'");
    expect(skipped[0]!.params).toEqual([USER_ID, VAC_ID, null]);
    expect(noteGivenWrites()).toHaveLength(0);
  });
});

describe('runNotify — a send that THROWS (timeout / network)', () => {
  it('does not fail the run: the next person still gets and records their letter', async () => {
    h.state.subs = [
      { user_id: USER_ID, telegram_id: '555' },
      { user_id: USER_B, telegram_id: '666' },
    ];
    h.state.replies['555'] = ['throw'];

    const r = await runOnFakeClock();

    expect(r.error).toBeUndefined();
    expect(r.done).toBe(true);
    expect(h.state.sent.map((s) => String(s.chatId))).toEqual(['555', '666']);
    expect(r.result!.sent).toBe(1);
    // the thrown letter is NOT recorded (its offer stays pending); the next person's is
    expect(notifInserts().map((c) => c.params[0])).toEqual([USER_B]);
  });

  it('the line is not doubled: a last letter that threw marks the person, the resend goes without it', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 4 }];
    h.state.replies['555'] = ['throw'];

    await runOnFakeClock();
    expect(h.state.noteGiven).toEqual({ day: seoulDay(), users: [USER_ID] });

    nextRun();
    await runOnFakeClock();

    expect(h.state.sent).toHaveLength(2);
    expect(h.state.sent[0]!.text).toContain(NOTIFY_LAST_LETTER_NOTE); // the one that may have arrived
    expect(h.state.sent[1]!.text).not.toContain(NOTIFY_LAST_LETTER_NOTE); // the resend
    expect(h.state.sent[1]!.text.startsWith('Новая вакансия:')).toBe(true);
  });

  it('a thrown letter that was NOT the last marks nobody (and the mark is not even read)', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 2 }];
    h.state.replies['555'] = ['throw'];

    await runOnFakeClock();

    expect(noteGivenWrites()).toHaveLength(0);
    expect(noteGivenReads()).toHaveLength(0);
  });

  it('a mark left from ANOTHER day is ignored: today’s last letter carries the line', async () => {
    h.state.noteGiven = { day: '2000-01-01', users: [USER_ID] };
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 4 }];

    await runOnFakeClock();

    expect(h.state.sent[0]!.text).toContain(NOTIFY_LAST_LETTER_NOTE);
  });

  it('a FAILED read of the marks never overwrites them: everyone else keeps their mark', async () => {
    h.state.noteGiven = { day: seoulDay(), users: [USER_B] };
    h.state.noteGivenReadThrows = true;
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 4 }];
    h.state.replies['555'] = ['throw']; // last letter, outcome unknown -> the run wants to mark USER_ID

    const r = await runOnFakeClock();

    expect(r.error).toBeUndefined();
    expect(noteGivenReads()).toHaveLength(1);
    expect(noteGivenWrites()).toHaveLength(0);
    expect(h.state.noteGiven).toEqual({ day: seoulDay(), users: [USER_B] });
  });

  it('a mark for SOMEONE ELSE does not take the line from this person', async () => {
    h.state.noteGiven = { day: seoulDay(), users: [USER_B] };
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 4 }];

    await runOnFakeClock();

    expect(h.state.sent[0]!.text).toContain(NOTIFY_LAST_LETTER_NOTE);
  });
});

describe('runNotify — a delivered letter whose record failed', () => {
  it('one failed INSERT neither stops the run nor drops the other offers or people', async () => {
    h.state.vacs = [vacancyRow(), vacancyRow(VAC_2)];
    h.state.matchCalls = 2;
    h.state.subs = [
      { user_id: USER_ID, telegram_id: '555' },
      { user_id: USER_B, telegram_id: '666' },
    ];
    h.state.recordSentThrows = 1; // the very first 'sent' INSERT fails

    const r = await runOnFakeClock();

    expect(r.error).toBeUndefined();
    expect(r.result!.sent).toBe(2);
    const sentRows = notifInserts().filter((c) => /'sent'/.test(c.text));
    expect(sentRows.map((c) => c.params.slice(0, 2))).toEqual([
      [USER_ID, VAC_ID], // failed
      [USER_ID, VAC_2],
      [USER_B, VAC_ID],
      [USER_B, VAC_2],
    ]);
  });

  it('the last letter delivered but unrecorded marks the person; the resend goes without the line', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 4 }];
    h.state.recordSentThrows = 1;

    await runOnFakeClock();
    expect(h.state.noteGiven).toEqual({ day: seoulDay(), users: [USER_ID] });

    nextRun();
    await runOnFakeClock();

    expect(h.state.sent).toHaveLength(2);
    expect(h.state.sent.filter((s) => s.text.includes(NOTIFY_LAST_LETTER_NOTE))).toHaveLength(1);
  });

  it('a recorded last letter marks nobody (the count itself already says «used up»)', async () => {
    h.state.budgets = [{ user_id: USER_ID, cap: 5, letters: 4 }];

    await runOnFakeClock();

    expect(noteGivenWrites()).toHaveLength(0);
  });
});

describe('runNotify — the pause after a 429, and the lease that must outlive any run', () => {
  it('rateLimitSleepMs: retry_after + 1 s, never more than 10 s', () => {
    expect(NOTIFY_RATE_LIMIT_SLEEP_MAX_SECONDS).toBe(10);
    expect(rateLimitSleepMs(0)).toBe(1_000);
    expect(rateLimitSleepMs(3)).toBe(4_000);
    expect(rateLimitSleepMs(9)).toBe(10_000);
    expect(rateLimitSleepMs(3_600)).toBe(10_000);
  });

  it('told to wait an hour, the run pauses at most 10 s and stops', async () => {
    h.state.replies['555'] = [{ ok: false, error_code: 429, parameters: { retry_after: 3_600 } }];

    const r = await runOnFakeClock(20_000);

    expect(r.done).toBe(true);
    expect(r.elapsedMs).toBeLessThanOrEqual(NOTIFY_RATE_LIMIT_SLEEP_MAX_SECONDS * 1000 + 100);
    expect(r.result!.sent).toBe(0);
    expect(notifInserts()).toHaveLength(0); // the letter stays pending for the next tick
  });

  it('NOTIFY_LEASE_SECONDS > every maxDuration in vercel.json (the comment’s invariant)', () => {
    const vercel = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../vercel.json', import.meta.url)), 'utf8'),
    ) as { functions?: Record<string, { maxDuration?: unknown }> };
    const durations = Object.values(vercel.functions ?? {}).map((f) => f.maxDuration);
    expect(durations.length).toBeGreaterThan(0);
    for (const d of durations) {
      expect(typeof d).toBe('number');
      expect(NOTIFY_LEASE_SECONDS).toBeGreaterThan(d as number);
    }
    // and the longest 429 pause fits well inside one function's life
    expect(NOTIFY_RATE_LIMIT_SLEEP_MAX_SECONDS).toBeLessThan(Math.min(...(durations as number[])));
  });
});
