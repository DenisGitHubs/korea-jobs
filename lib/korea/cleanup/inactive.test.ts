// lib/korea/cleanup/inactive.test.ts
//
// runInactiveErase — the mechanism behind the Privacy Policy promise «удаляем данные через
// 12 месяцев без входа». The DB is a fake tagged-template `sql` routed by statement shape and
// the config is stubbed, so the whole sweep (including its refusal to run) is exercised with
// no Postgres.
//
// What is pinned here — these are the properties the promise and the referral economy rest on:
//   * MASTER SWITCH OFF (the shipped default) => not a single statement is issued, ever;
//   * only genuinely dormant accounts are picked: the candidate query filters by
//     deleted_at is null (idempotency), role <> 'admin', AND both last_seen_at and created_at
//     older than the term;
//   * the term is CLAMPED in code — a fat-fingered `0` in config can never mean "erase everybody";
//   * OTHER PEOPLE'S CHAINS SURVIVE: referral_activations is never deleted (its cascade would
//     take the inviter's ledger rows with it), the users row is never DELETEd (only stripped),
//     and the ledger delete is scoped to the person as RECIPIENT, never as source_user_id;
//   * the erase itself removes every identifier and stamps deleted_at;
//   * the person's ads are deleted, so they leave the feed;
//   * IDEMPOTENT: a second pass finds nothing (the stamp excludes them) and writes nothing;
//   * batching: it loops while batches come back full, and stops on the batch ceiling or the
//     wall-clock budget.

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type Call = { text: string; params: unknown[] };

const U1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const U2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const h = vi.hoisted(() => {
  const state = {
    enabled: true,
    months: 12,
    batch: 200,
    maxBatches: 5,
    /** Successive answers to the candidate query; anything past the end is an empty batch. */
    candidateBatches: [] as { id: string; tid: string | null }[][],
    calls: [] as Call[],
    /** Simulates a deploy-before-migrate window where bot_inbox does not exist yet. */
    botInboxThrows: false,
  };
  const fakeSql = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<Row[]> => {
    const text = typeof strings === 'string' ? strings : (strings as unknown as string[]).join('?');
    state.calls.push({ text, params });

    if (/select id, telegram_id::text as tid/.test(text)) {
      return Promise.resolve((state.candidateBatches.shift() ?? []) as unknown as Row[]);
    }
    if (/update users set/.test(text)) {
      const ids = (params[0] as string[] | undefined) ?? [];
      return Promise.resolve([{ n: ids.length }]);
    }
    if (/delete from bot_inbox\b/.test(text) && state.botInboxThrows) {
      return Promise.reject(new Error('relation "bot_inbox" does not exist'));
    }
    if (/delete from/.test(text)) return Promise.resolve([{ n: 1 }]);
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('../config.js', () => ({
  getConfigBool: async (key: string, fallback: boolean) =>
    key === 'inactive_delete_enabled' ? h.state.enabled : fallback,
  getConfigNumber: async (key: string, fallback: number) => {
    if (key === 'inactive_delete_months') return h.state.months;
    if (key === 'inactive_delete_batch') return h.state.batch;
    if (key === 'inactive_delete_max_batches') return h.state.maxBatches;
    return fallback;
  },
}));

import {
  runInactiveErase,
  eraseUsers,
  eraseBotLedgers,
  emptyEraseCounts,
  INACTIVE_ERASE_TIME_BUDGET_MS,
  MONTHS_MIN,
  MONTHS_MAX,
} from './inactive.js';

/** A clock that never advances (the time budget is out of the way unless a test wants it). */
const frozenClock = { now: () => 0 };

const candidateQueries = () => h.state.calls.filter((c) => /select id, telegram_id::text as tid/.test(c.text));
const deletesOn = (table: string) =>
  h.state.calls.filter((c) => new RegExp(`delete from ${table}\\b`).test(c.text));
const stampUpdates = () => h.state.calls.filter((c) => /update users set/.test(c.text));

beforeEach(() => {
  h.state.enabled = true;
  h.state.months = 12;
  h.state.batch = 200;
  h.state.maxBatches = 5;
  h.state.candidateBatches = [];
  h.state.calls = [];
  h.state.botInboxThrows = false;
});

/** The fake `sql` as the shared eraseUsers/eraseBotLedgers signature sees it. */
const sql = h.fakeSql as unknown as Parameters<typeof eraseUsers>[0];

// ─────────────────────────────────────────────────────────────────────────────
// The master switch
// ─────────────────────────────────────────────────────────────────────────────

describe('runInactiveErase — master switch OFF (the shipped default)', () => {
  it('issues NO statement at all and reports enabled=false', async () => {
    h.state.enabled = false;
    h.state.candidateBatches = [[{ id: U1, tid: '111' }]]; // would be erased if it ever looked

    const r = await runInactiveErase(frozenClock);

    expect(h.state.calls).toHaveLength(0);
    expect(r.enabled).toBe(false);
    expect(r.usersErased).toBe(0);
    expect(r.stoppedReason).toBe('disabled');
  });

  it('still reports the configured term, so a dry run can be read off the response', async () => {
    h.state.enabled = false;
    h.state.months = 24;
    const r = await runInactiveErase(frozenClock);
    expect(r.months).toBe(24);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Who gets picked
// ─────────────────────────────────────────────────────────────────────────────

describe('runInactiveErase — candidate selection', () => {
  it('asks only for LIVE, non-admin accounts dormant past the term (both timestamps)', async () => {
    h.state.candidateBatches = [[]];

    await runInactiveErase(frozenClock);

    const q = candidateQueries()[0]!;
    expect(q.text).toMatch(/deleted_at is null/);
    expect(q.text).toMatch(/role <> 'admin'/);
    expect(q.text).toMatch(/last_seen_at < now\(\) - make_interval\(months =>/);
    expect(q.text).toMatch(/created_at\s+< now\(\) - make_interval\(months =>/);
    expect(q.params[0]).toBe(12); // the term
  });

  it('writes NOTHING when nobody is dormant', async () => {
    h.state.candidateBatches = [[]];

    const r = await runInactiveErase(frozenClock);

    expect(candidateQueries()).toHaveLength(1);
    expect(h.state.calls.filter((c) => /delete from|update users/.test(c.text))).toHaveLength(0);
    expect(r.usersErased).toBe(0);
    expect(r.stoppedReason).toBe('done');
  });

  it('CLAMPS a 0-month term to the floor — a config typo can never erase everybody', async () => {
    h.state.months = 0;
    h.state.candidateBatches = [[]];

    const r = await runInactiveErase(frozenClock);

    expect(candidateQueries()[0]!.params[0]).toBe(MONTHS_MIN);
    expect(r.months).toBe(MONTHS_MIN);
  });

  it('clamps a negative / absurd term into the allowed window', async () => {
    h.state.months = -5;
    h.state.candidateBatches = [[]];
    expect((await runInactiveErase(frozenClock)).months).toBe(MONTHS_MIN);

    h.state.calls = [];
    h.state.months = 9999;
    h.state.candidateBatches = [[]];
    expect((await runInactiveErase(frozenClock)).months).toBe(MONTHS_MAX);
  });

  it('clamps the batch size and passes it as the LIMIT', async () => {
    h.state.batch = 99999;
    h.state.candidateBatches = [[]];

    await runInactiveErase(frozenClock);

    // params: [months (last_seen_at), months (created_at), limit]
    expect(candidateQueries()[0]!.params[2]).toBe(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What an erase actually does
// ─────────────────────────────────────────────────────────────────────────────

describe('runInactiveErase — erasing a dormant account', () => {
  beforeEach(() => {
    h.state.candidateBatches = [[{ id: U1, tid: '111' }, { id: U2, tid: '222' }]];
  });

  it('deletes every table that holds the person’s own data, scoped to the batch', async () => {
    await runInactiveErase(frozenClock);

    for (const table of [
      'notifications_sent',
      'contact_reveals',
      'ad_contact_reveals',
      'raw_contact_reveals',
      'saved_vacancies',
      'saved_ads',
      'vacancy_reports',
      'streak_awards',
      'cooperation_requests',
      'subscriptions',
      'referral_points_ledger',
      'user_ads',
    ]) {
      const calls = deletesOn(table);
      expect(calls, `expected exactly one delete on ${table}`).toHaveLength(1);
      expect(calls[0]!.params[0]).toEqual([U1, U2]);
    }
  });

  it('drops their ADS so the ad leaves the feed (scoped by author)', async () => {
    await runInactiveErase(frozenClock);

    const ads = deletesOn('user_ads')[0]!;
    expect(ads.text).toMatch(/delete from user_ads where author_user_id = any\(\?::uuid\[\]\)/);
  });

  it('clears the webhook ledger by RAW telegram id (it has no FK to users)', async () => {
    await runInactiveErase(frozenClock);

    const bu = deletesOn('bot_updates');
    expect(bu).toHaveLength(1);
    expect(bu[0]!.params[0]).toEqual(['111', '222']);
  });

  it('skips the bot_updates statement when the batch carries no telegram ids', async () => {
    h.state.candidateBatches = [[{ id: U1, tid: null }]];

    await runInactiveErase(frozenClock);

    expect(deletesOn('bot_updates')).toHaveLength(0);
  });

  it('strips every identifier and stamps deleted_at instead of deleting the row', async () => {
    const r = await runInactiveErase(frozenClock);

    const upd = stampUpdates();
    expect(upd).toHaveLength(1);
    expect(upd[0]!.text).toMatch(/telegram_id\s+= null/);
    expect(upd[0]!.text).toMatch(/username\s+= null/);
    expect(upd[0]!.text).toMatch(/first_name\s+= null/);
    expect(upd[0]!.text).toMatch(/last_name\s+= null/);
    expect(upd[0]!.text).toMatch(/public_id\s+= encode\(gen_random_bytes\(8\), 'hex'\)/);
    expect(upd[0]!.text).toMatch(/terms_accepted_at\s+= null/);
    expect(upd[0]!.text).toMatch(/deleted_at\s+= now\(\)/);
    expect(upd[0]!.params[0]).toEqual([U1, U2]);
    expect(r.usersErased).toBe(2);
    expect(r.enabled).toBe(true);
  });

  it('re-stamps only LIVE rows, so a concurrent tick cannot double-erase', async () => {
    await runInactiveErase(frozenClock);
    expect(stampUpdates()[0]!.text).toMatch(/and deleted_at is null/);
  });

  it('reports honest per-group counters', async () => {
    const r = await runInactiveErase(frozenClock);

    expect(r.batches).toBe(1);
    expect(r.subscriptionsDeleted).toBe(1);
    expect(r.adsDeleted).toBe(1);
    expect(r.revealsDeleted).toBe(3); // vacancy + ad + raw reveal tables
    expect(r.savedDeleted).toBe(2); // saved_vacancies + saved_ads
    expect(r.stoppedReason).toBe('done');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Other people's data must not move (the whole reason this is not a plain DELETE)
// ─────────────────────────────────────────────────────────────────────────────

describe('runInactiveErase — third parties are untouched', () => {
  beforeEach(() => {
    h.state.candidateBatches = [[{ id: U1, tid: '111' }]];
  });

  it('NEVER deletes referral_activations — that cascade would erase the INVITER’s credits', async () => {
    await runInactiveErase(frozenClock);
    expect(deletesOn('referral_activations')).toHaveLength(0);
  });

  it('NEVER deletes the users row itself (the anonymous node keeps chains intact)', async () => {
    await runInactiveErase(frozenClock);
    expect(h.state.calls.filter((c) => /delete from users\b/.test(c.text))).toHaveLength(0);
  });

  it('touches ledger rows only where the person is the RECIPIENT, never as source_user_id', async () => {
    await runInactiveErase(frozenClock);

    const led = deletesOn('referral_points_ledger')[0]!;
    expect(led.text).toMatch(/delete from referral_points_ledger where user_id = any\(\?::uuid\[\]\)/);
    expect(h.state.calls.some((c) => /source_user_id/.test(c.text))).toBe(false);
  });

  it('leaves the ancestor pointers (referred_by / ref_l2 / ref_l3) alone', async () => {
    await runInactiveErase(frozenClock);

    const upd = stampUpdates()[0]!;
    expect(upd.text).not.toMatch(/referred_by/);
    expect(upd.text).not.toMatch(/ref_l2/);
    expect(upd.text).not.toMatch(/ref_l3/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency + batching
// ─────────────────────────────────────────────────────────────────────────────

describe('runInactiveErase — idempotency', () => {
  it('a second pass over the same people writes nothing (the stamp excludes them)', async () => {
    h.state.candidateBatches = [[{ id: U1, tid: '111' }]]; // first pass finds one, then nothing

    const first = await runInactiveErase(frozenClock);
    expect(first.usersErased).toBe(1);

    h.state.calls = [];
    h.state.candidateBatches = [[]]; // the stamped row no longer matches `deleted_at is null`

    const second = await runInactiveErase(frozenClock);

    expect(second.usersErased).toBe(0);
    expect(h.state.calls.filter((c) => /delete from|update users/.test(c.text))).toHaveLength(0);
  });

  it('stops after a SHORT batch instead of paying for another scan', async () => {
    h.state.batch = 2;
    h.state.candidateBatches = [[{ id: U1, tid: '111' }]]; // 1 < 2 => drained

    await runInactiveErase(frozenClock);

    expect(candidateQueries()).toHaveLength(1);
  });
});

describe('runInactiveErase — batching limits', () => {
  it('keeps going while batches come back FULL, up to the batch ceiling', async () => {
    h.state.batch = 1;
    h.state.maxBatches = 3;
    h.state.candidateBatches = [
      [{ id: U1, tid: '1' }],
      [{ id: U2, tid: '2' }],
      [{ id: U1, tid: '3' }],
      [{ id: U2, tid: '4' }], // never reached — the ceiling is 3
    ];

    const r = await runInactiveErase(frozenClock);

    expect(r.batches).toBe(3);
    expect(r.usersErased).toBe(3);
    expect(r.stoppedReason).toBe('max_batches');
  });

  it('bails cleanly when the wall-clock budget is spent (the rest waits for the next tick)', async () => {
    h.state.batch = 1;
    h.state.maxBatches = 10;
    h.state.candidateBatches = [
      [{ id: U1, tid: '1' }],
      [{ id: U2, tid: '2' }],
      [{ id: U1, tid: '3' }],
    ];
    let t = 0;
    const clock = {
      now: () => {
        const v = t;
        t += INACTIVE_ERASE_TIME_BUDGET_MS; // one batch's worth of "work" per read
        return v;
      },
    };

    const r = await runInactiveErase(clock);

    expect(r.stoppedReason).toBe('budget');
    expect(r.batches).toBeLessThan(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// eraseUsers — the SHARED erasure (007 M2): the sweep and the on-request admin deletion must
// run byte-for-byte the same statements, so a hand-triggered deletion can never take the
// dangerous `delete from users` shortcut that would cascade into an inviter's ledger.
// ─────────────────────────────────────────────────────────────────────────────

describe('eraseUsers — the one implementation both paths use', () => {
  it('an EMPTY list issues no statement at all', async () => {
    const counts = await eraseUsers(sql, []);
    expect(h.state.calls).toHaveLength(0);
    expect(counts).toEqual(emptyEraseCounts());
  });

  it('erases one named account exactly like the sweep does (same tables, same scope)', async () => {
    const counts = await eraseUsers(sql, [{ id: U1, tid: '111' }]);

    for (const table of [
      'notifications_sent',
      'contact_reveals',
      'ad_contact_reveals',
      'raw_contact_reveals',
      'saved_vacancies',
      'saved_ads',
      'vacancy_reports',
      'streak_awards',
      'cooperation_requests',
      'subscriptions',
      'referral_points_ledger',
      'user_ads',
    ]) {
      expect(deletesOn(table), `expected exactly one delete on ${table}`).toHaveLength(1);
    }
    expect(stampUpdates()).toHaveLength(1);
    expect(counts.usersErased).toBe(1);
  });

  it('keeps the ORDER that makes a half-finished erasure safe: the users stamp is LAST', async () => {
    await eraseUsers(sql, [{ id: U1, tid: '111' }]);
    const stampIndex = h.state.calls.findIndex((c) => /update users set/.test(c.text));
    expect(stampIndex).toBe(h.state.calls.length - 1);
  });

  it('NEVER deletes the users row and NEVER touches referral_activations', async () => {
    await eraseUsers(sql, [{ id: U1, tid: '111' }]);
    expect(h.state.calls.filter((c) => /delete from users\b/.test(c.text))).toHaveLength(0);
    expect(deletesOn('referral_activations')).toHaveLength(0);
  });

  it('clears BOTH telegram-id ledgers: bot_updates and bot_inbox (007 minor)', async () => {
    const counts = await eraseUsers(sql, [
      { id: U1, tid: '111' },
      { id: U2, tid: '222' },
    ]);

    const inbox = deletesOn('bot_inbox');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.text).toMatch(/delete from bot_inbox where from_id = any\(\?::bigint\[\]\)/);
    expect(inbox[0]!.params[0]).toEqual(['111', '222']);
    expect(counts.botInboxDeleted).toBe(1);
    expect(deletesOn('bot_updates')).toHaveLength(1);
  });

  it('skips both ledgers when the account has no telegram id left', async () => {
    await eraseUsers(sql, [{ id: U1, tid: null }]);
    expect(deletesOn('bot_inbox')).toHaveLength(0);
    expect(deletesOn('bot_updates')).toHaveLength(0);
  });

  it('a missing bot_inbox table (deploy-before-migrate) never fails the erasure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.state.botInboxThrows = true;

    const counts = await eraseUsers(sql, [{ id: U1, tid: '111' }]);

    expect(counts.usersErased).toBe(1); // the person IS erased
    expect(counts.botInboxDeleted).toBe(0);
    expect(stampUpdates()).toHaveLength(1);
    spy.mockRestore();
  });
});

describe('eraseBotLedgers — for a person who has no account at all', () => {
  it('clears both ledgers by raw telegram id', async () => {
    const out = await eraseBotLedgers(sql, ['555']);

    expect(deletesOn('bot_updates')[0]!.params[0]).toEqual(['555']);
    expect(deletesOn('bot_inbox')[0]!.params[0]).toEqual(['555']);
    expect(out).toEqual({ botUpdatesDeleted: 1, botInboxDeleted: 1 });
  });

  it('does nothing for an empty list', async () => {
    const out = await eraseBotLedgers(sql, []);
    expect(h.state.calls).toHaveLength(0);
    expect(out).toEqual({ botUpdatesDeleted: 0, botInboxDeleted: 0 });
  });
});

describe('runInactiveErase — still clears the inbox ledger of the accounts it sweeps', () => {
  it('deletes bot_inbox rows for the swept telegram ids', async () => {
    h.state.candidateBatches = [[{ id: U1, tid: '111' }]];

    const r = await runInactiveErase(frozenClock);

    expect(deletesOn('bot_inbox')).toHaveLength(1);
    expect(deletesOn('bot_inbox')[0]!.params[0]).toEqual(['111']);
    expect(r.botInboxDeleted).toBe(1);
  });
});
