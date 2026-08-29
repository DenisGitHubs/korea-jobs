// collector/src/schedule.test.ts
//
// Alignment is not cosmetic. A Neon compute sleeps only after 5 minutes of silence, so two
// independent 15-minute timers 7 minutes apart in phase wake the database every 7 minutes and it
// never sleeps — the outage repeats with a tenth of the traffic. What must hold is that the
// reader's window lands on the SAME wall-clock instants a `*/15` crontab fires on, without the
// two hosts ever talking to each other.

import { describe, it, expect, vi } from 'vitest';
import { msUntilNextBoundary, startAlignedInterval, type AlignedTimerDeps } from './schedule.js';

const MIN = 60_000;
const at = (iso: string): number => new Date(iso).getTime();

describe('msUntilNextBoundary — the next wall-clock quarter, not "15 minutes from now"', () => {
  it('lands on :00 / :15 / :30 / :45 whenever the reader happened to start', () => {
    const q = 15 * MIN;
    expect(msUntilNextBoundary(at('2026-08-29T10:07:00Z'), q)).toBe(8 * MIN); // -> 10:15
    expect(msUntilNextBoundary(at('2026-08-29T10:14:59Z'), q)).toBe(1_000); // -> 10:15
    expect(msUntilNextBoundary(at('2026-08-29T10:46:30Z'), q)).toBe(13 * MIN + 30_000); // -> 11:00
  });

  it('exactly ON a boundary waits a full interval (never fires twice at one instant)', () => {
    const q = 15 * MIN;
    expect(msUntilNextBoundary(at('2026-08-29T10:30:00Z'), q)).toBe(q);
    expect(msUntilNextBoundary(0, q)).toBe(q);
  });

  it('two processes started minutes apart converge on the same instant', () => {
    const q = 15 * MIN;
    const reader = at('2026-08-29T10:02:00Z');
    const cron = at('2026-08-29T10:11:20Z');
    expect(reader + msUntilNextBoundary(reader, q)).toBe(at('2026-08-29T10:15:00Z'));
    expect(cron + msUntilNextBoundary(cron, q)).toBe(at('2026-08-29T10:15:00Z'));
  });

  it('every interval that divides an hour keeps the answer inside (0, interval]', () => {
    for (const minutes of [1, 5, 10, 15, 20, 30, 60]) {
      const interval = minutes * MIN;
      for (const t of [at('2026-08-29T10:07:03Z'), at('2026-08-29T23:59:59Z'), 0, 12_345]) {
        const d = msUntilNextBoundary(t, interval);
        expect(d).toBeGreaterThan(0);
        expect(d).toBeLessThanOrEqual(interval);
        expect((t + d) % interval).toBe(0);
      }
    }
  });

  it('rejects a nonsense interval instead of scheduling a tight loop', () => {
    expect(() => msUntilNextBoundary(Date.now(), 0)).toThrow(/positive/);
    expect(() => msUntilNextBoundary(Date.now(), -5)).toThrow(/positive/);
    expect(() => msUntilNextBoundary(Date.now(), Number.NaN)).toThrow(/positive/);
  });
});

/** A hand-driven clock + timer, so the schedule can be tested without waiting 15 minutes. */
function fakeTimers(startMs: number) {
  let now = startMs;
  const queue: { at: number; fn: () => void }[] = [];
  const deps: AlignedTimerDeps = {
    now: () => now,
    setTimer: (fn, ms) => {
      const entry = { at: now + ms, fn };
      queue.push(entry);
      return entry;
    },
    clearTimer: (h) => {
      const i = queue.indexOf(h as { at: number; fn: () => void });
      if (i >= 0) queue.splice(i, 1);
    },
  };
  /** Advance the clock and run whatever came due, in order. */
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      const next = queue.filter((e) => e.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      queue.splice(queue.indexOf(next), 1);
      now = next.at;
      next.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    now = target;
  };
  return { deps, advance, pending: () => queue.length };
}

describe('startAlignedInterval — fires on the boundary, re-arms, never overlaps', () => {
  it('first run is at the next boundary, not one interval after start', async () => {
    const t = fakeTimers(at('2026-08-29T10:07:00Z'));
    const task = vi.fn(async () => undefined);
    startAlignedInterval(15 * MIN, task, t.deps);

    await t.advance(7 * MIN + 59_000);
    expect(task).not.toHaveBeenCalled();
    await t.advance(1_000); // 10:15:00
    expect(task).toHaveBeenCalledTimes(1);

    await t.advance(15 * MIN); // 10:30:00
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('a task that throws does not stop the schedule', async () => {
    const t = fakeTimers(at('2026-08-29T10:00:00Z'));
    const task = vi.fn(async () => {
      throw new Error('ingest down');
    });
    startAlignedInterval(15 * MIN, task, t.deps);

    await t.advance(15 * MIN);
    await t.advance(15 * MIN);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('stop() cancels the pending window', async () => {
    const t = fakeTimers(at('2026-08-29T10:00:00Z'));
    const task = vi.fn(async () => undefined);
    const stop = startAlignedInterval(15 * MIN, task, t.deps);

    stop();
    await t.advance(60 * MIN);
    expect(task).not.toHaveBeenCalled();
    expect(t.pending()).toBe(0);
  });
});
