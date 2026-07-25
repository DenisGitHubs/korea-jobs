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
    subsCalls: 0,
    matchCalls: 0, // how many subscriber lookups belong to the MATCH phase (step 2)
    calls: [] as Call[],
    sent: [] as { chatId: number | string; text: string; extra: Record<string, unknown> }[],
  };
  const fakeSql = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<Row[]> => {
    const text = typeof strings === 'string' ? strings : (strings as unknown as string[]).join('?');
    state.calls.push({ text, params });

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
    return Promise.resolve({ ok: true, result: { message_id: 777 } });
  },
  isUserUnavailable: () => false,
  retryAfterSeconds: () => null,
}));

import { runNotify } from './run.js';

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
  h.state.subsCalls = 0;
  h.state.matchCalls = 1; // one vacancy fetched -> one match lookup in step 2
  h.state.calls = [];
  h.state.sent = [];
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
  it('a FRESH subscription (saved without the field, so cap NULL in the DB) is never limited', async () => {
    // Owner, 2026-07-26: «всем без ограничений. Захотят изменить — то изменят в настройках кол-во».
    // POST /api/subscription stores NULL for such a row (subscriptions/rw.ts) and the column itself
    // has no DEFAULT (draft_0026) — so the very first thing this run must do is send, not skip.
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
