// lib/korea/cron/tick.test.ts
//
// The combined cron pass. Everything here is about the two things that make "one scheduled call"
// safe rather than reckless:
//
//   1. THE BUDGET IS REAL. Vercel kills the function at 60s. A step is started only while its
//      reserve still fits in the 45s budget; what does not fit is REPORTED as skipped and picked
//      up by the next tick. A pass that quietly runs out of time is indistinguishable from a pass
//      that did the work — which is how a product ends up dark for eleven days without anybody
//      being able to say which step stopped.
//   2. NO STEP CAN TAKE THE OTHERS DOWN. One thrown step is recorded and the pass continues.
//
// Plus the ordering rule: users' work first, except once an hour, when maintenance (retention,
// erasure — the things we promised people) goes first so a busy pipeline cannot starve it.

import { describe, it, expect, vi } from 'vitest';
import {
  runTick,
  stepOrder,
  maintenanceFirst,
  STEP_RESERVE_MS,
  TICK_TIME_BUDGET_MS,
  PARSE_MAX_PASSES,
  DATA_STEPS,
  MAINTENANCE_STEPS,
  TAIL_STEPS,
  type TickDeps,
  type TickStepName,
} from './tick.js';

/** A clock the test moves by hand, plus runners that record their order and cost time. */
function makeDeps(opts: {
  startIso?: string;
  /** Milliseconds each named step consumes (default 100ms). */
  cost?: Partial<Record<TickStepName, number>>;
  /** Steps that throw. */
  throws?: TickStepName[];
  /** What a runner returns (the parse runner may return a queue of answers). */
  returns?: Partial<Record<TickStepName, unknown>>;
  parseQueue?: unknown[];
}) {
  let now = new Date(opts.startIso ?? '2026-08-29T10:15:00Z').getTime();
  const order: string[] = [];
  const runners = {} as TickDeps['runners'];
  // TAIL_STEPS included: the watchdog is a real step of every pass (always last).
  const names: TickStepName[] = [...DATA_STEPS, ...MAINTENANCE_STEPS, ...TAIL_STEPS];
  for (const name of names) {
    runners[name] = vi.fn(async () => {
      order.push(name);
      now += opts.cost?.[name] ?? 100;
      if (opts.throws?.includes(name)) throw new Error(`${name} exploded`);
      if (name === 'parse' && opts.parseQueue) return opts.parseQueue.shift() ?? { processed: 0 };
      return opts.returns?.[name] ?? { ok: true };
    });
  }
  const deps: TickDeps = { now: () => now, runners };
  return { deps, order, runners };
}

describe('stepOrder — users first, maintenance first once an hour', () => {
  it('puts the data steps first for most of the hour', () => {
    for (const iso of ['2026-08-29T10:15:00Z', '2026-08-29T10:30:00Z', '2026-08-29T10:45:00Z']) {
      expect(stepOrder(new Date(iso))).toEqual([...DATA_STEPS, ...MAINTENANCE_STEPS, ...TAIL_STEPS]);
    }
  });

  it('flips the order on the first tick of the hour, so retention can never starve', () => {
    expect(maintenanceFirst(new Date('2026-08-29T10:00:00Z'))).toBe(true);
    expect(stepOrder(new Date('2026-08-29T10:00:00Z'))).toEqual([
      ...MAINTENANCE_STEPS,
      ...DATA_STEPS,
      // The tail is appended in BOTH rotations — the watchdog must never look at the pipeline
      // before this tick's parse has had its turn.
      ...TAIL_STEPS,
    ]);
  });

  it('covers every step exactly once, whichever way round it goes', () => {
    const all = [...DATA_STEPS, ...MAINTENANCE_STEPS, ...TAIL_STEPS];
    for (const iso of ['2026-08-29T10:00:00Z', '2026-08-29T10:20:00Z']) {
      const order = stepOrder(new Date(iso));
      expect([...order].sort()).toEqual([...all].sort());
      expect(new Set(order).size).toBe(all.length);
    }
  });
});

describe('runTick — the whole pass on a quiet system', () => {
  it('runs every step once and reports what it did', async () => {
    const { deps, order } = makeDeps({});
    const out = await runTick(deps);

    expect(order).toEqual([...DATA_STEPS, ...MAINTENANCE_STEPS, ...TAIL_STEPS]);
    expect(out.ran).toEqual([...DATA_STEPS, ...MAINTENANCE_STEPS, ...TAIL_STEPS]);
    expect(out.skipped).toEqual([]);
    expect(out.failed).toEqual([]);
    expect(out.budgetMs).toBe(TICK_TIME_BUDGET_MS);
    expect(out.elapsedMs).toBeGreaterThan(0);
    expect(out.steps.parse).toEqual({ ok: true });
  });
});

describe('runTick — the budget stops it cleanly instead of the platform killing it', () => {
  it('does not START a step whose reserve no longer fits, and says so', async () => {
    // parse eats almost the whole budget; everything after it must be left for the next tick.
    const { deps, order, runners } = makeDeps({ cost: { parse: TICK_TIME_BUDGET_MS - 4_000 } });
    const out = await runTick(deps);

    expect(out.ran).toEqual(['parse']);
    expect(out.skipped).toEqual(['notify', ...MAINTENANCE_STEPS, ...TAIL_STEPS]);
    expect(order).toEqual(['parse']);
    expect(runners.notify).not.toHaveBeenCalled(); // not started at all — nothing is half-done
  });

  it('still runs the cheap steps that DO fit after an expensive one', async () => {
    // Leaves ~13s: enough for scheduled (10s) and digest (5s)? digest fits, cleanup (20s) does not.
    const { deps } = makeDeps({ cost: { parse: 20_000, notify: 12_000 } });
    const out = await runTick(deps);

    expect(out.ran).toContain('parse');
    expect(out.ran).toContain('notify');
    expect(out.ran).toContain('scheduled');
    expect(out.skipped).toContain('cleanup');
    // Every step is accounted for exactly once, either ran or skipped or failed.
    expect([...out.ran, ...out.skipped, ...out.failed].sort()).toEqual(
      [...DATA_STEPS, ...MAINTENANCE_STEPS, ...TAIL_STEPS].sort(),
    );
  });

  it('keeps the reserves inside the budget, so at least the first step can always start', () => {
    for (const name of [...DATA_STEPS, ...MAINTENANCE_STEPS, ...TAIL_STEPS]) {
      expect(STEP_RESERVE_MS[name]).toBeGreaterThan(0);
      expect(STEP_RESERVE_MS[name]).toBeLessThan(TICK_TIME_BUDGET_MS);
    }
  });
});

describe('runTick — one broken step never costs the others', () => {
  it('records the failure and carries on', async () => {
    const { deps, order } = makeDeps({ throws: ['notify'] });
    const out = await runTick(deps);

    expect(out.failed).toEqual(['notify']);
    expect(out.ran).toEqual(['parse', ...MAINTENANCE_STEPS, ...TAIL_STEPS]);
    expect(order).toEqual([...DATA_STEPS, ...MAINTENANCE_STEPS, ...TAIL_STEPS]); // it was attempted, then skipped over
    expect((out.steps.notify as { error: string }).error).toContain('exploded');
  });

  it('a failing first step does not stop maintenance on the hourly rotation', async () => {
    const { deps } = makeDeps({ startIso: '2026-08-29T11:00:00Z', throws: ['scheduled'] });
    const out = await runTick(deps);

    expect(out.maintenanceFirst).toBe(true);
    expect(out.failed).toEqual(['scheduled']);
    expect(out.ran).toEqual(['digest', 'cleanup', 'referral-confirm', ...DATA_STEPS, ...TAIL_STEPS]);
  });
});

describe('runTick — the parser drains its queue instead of falling behind', () => {
  it('runs another batch while the previous one had work and the budget allows', async () => {
    const { deps, runners } = makeDeps({
      cost: { parse: 1_000 },
      parseQueue: [{ processed: 20 }, { processed: 20 }, { processed: 20 }, { processed: 20 }],
    });
    const out = await runTick(deps);

    expect(runners.parse).toHaveBeenCalledTimes(PARSE_MAX_PASSES); // bounded, not "until empty"
    expect(out.steps.parse_2).toEqual({ processed: 20 });
    expect(out.steps.parse_3).toEqual({ processed: 20 });
    expect(out.steps.parse_4).toBeUndefined();
  });

  it('does not run a second batch when the first found nothing', async () => {
    const { deps, runners } = makeDeps({ parseQueue: [{ processed: 0, vacancies: 0 }] });
    await runTick(deps);
    expect(runners.parse).toHaveBeenCalledTimes(1); // an idle queue must not burn the window
  });

  it('stops repeating when the budget no longer holds another batch', async () => {
    const { deps, runners } = makeDeps({
      cost: { parse: TICK_TIME_BUDGET_MS - STEP_RESERVE_MS.parse + 1_000 }, // one second short of a second batch
      parseQueue: [{ processed: 20 }, { processed: 20 }],
    });
    const out = await runTick(deps);

    expect(runners.parse).toHaveBeenCalledTimes(1);
    expect(out.steps.parse_2).toBeUndefined();
    expect(out.skipped.length).toBeGreaterThan(0);
  });
});
