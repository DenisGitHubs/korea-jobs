// lib/korea/streaks/update.test.ts
//
// Verifies bumpStreak wires the award to the NEW per-Seoul-day idempotency key (award_day), so an
// honest rebuilt series that re-reaches a multiple of 7 on a later day pays again while a same-day
// double is impossible (owner decision 2026-07-21). No DB here: bumpStreak takes `sql` by
// injection, so we drive it with a fake that captures the statement text + bound params. The
// per-Seoul-day uniqueness itself is enforced by the DB constraint unique(user_id,kind,award_day);
// what we pin here is that the code TARGETS that constraint and binds award_day = today ($4) — the
// same param the day-advance guard uses, so award and advance always agree on "which day".

import { describe, it, expect, vi } from 'vitest';

// getConfigNumber would otherwise reach for getSql()/DATABASE_URL; stub it to the code default so
// the test is hermetic and deterministic (visit -> 20, open -> 30).
vi.mock('../config.js', () => ({
  getConfigNumber: vi.fn(async (_key: string, fallback: number) => fallback),
}));

import { bumpStreak } from './update.js';
import { seoulDate } from '../core/time.js';

type Captured = { text: string; params: unknown[] };

/** A fake `sql` (ordinary-call form) that records the statement and returns one canned row. */
function fakeSql(row: { len: number; awarded: number }) {
  const calls: Captured[] = [];
  const fn = ((text: string, params?: unknown[]) => {
    calls.push({ text, params: params ?? [] });
    return Promise.resolve([row]);
  }) as unknown as Parameters<typeof bumpStreak>[0];
  return { fn, calls };
}

describe('bumpStreak — award idempotency is keyed by Seoul-day (award_day)', () => {
  it('inserts award_day and conflicts on (user_id, kind, award_day), not streak_len', async () => {
    const { fn, calls } = fakeSql({ len: 7, awarded: 20 });
    const res = await bumpStreak(fn, 'user-1', 'visit');

    expect(res).toEqual({ len: 7, awarded: 20 });
    expect(calls).toHaveLength(1);
    const { text, params } = calls[0]!;

    // the insert now carries award_day, bound to the $today param ($4)...
    expect(text).toMatch(/insert into streak_awards \(user_id, kind, amount, streak_len, award_day\)/);
    expect(text).toContain('$4::date');
    // ...and idempotency is per Seoul-day, NOT per streak_len anymore.
    expect(text).toContain('on conflict (user_id, kind, award_day) do nothing');
    expect(text).not.toContain('on conflict (user_id, kind, streak_len)');

    // $4 is today's Seoul day — the same value the upd day-advance guard compares against.
    expect(params[0]).toBe('user-1');
    expect(params[1]).toBe('visit');
    expect(params[2]).toBe(20); // visit bonus default
    expect(params[3]).toBe(seoulDate());
    expect(params[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uses the open-kind bonus default with the same award_day wiring', async () => {
    const { fn, calls } = fakeSql({ len: 14, awarded: 30 });
    const res = await bumpStreak(fn, 'user-2', 'open');

    expect(res).toEqual({ len: 14, awarded: 30 });
    const { text, params } = calls[0]!;
    expect(params[1]).toBe('open');
    expect(params[2]).toBe(30); // open bonus default
    expect(params[3]).toBe(seoulDate());
    expect(text).toContain('on conflict (user_id, kind, award_day) do nothing');
  });

  it('reports len/awarded straight from the returned row (0/0 when nothing came back)', async () => {
    const empty = (() => Promise.resolve([])) as unknown as Parameters<typeof bumpStreak>[0];
    expect(await bumpStreak(empty, 'user-3', 'visit')).toEqual({ len: 0, awarded: 0 });
  });
});
