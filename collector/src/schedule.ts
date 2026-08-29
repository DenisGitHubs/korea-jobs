// collector/src/schedule.ts
//
// WALL-CLOCK ALIGNMENT — the other half of the sleep story (see batcher.ts for the first half).
//
// Batching alone is not enough. A Neon compute sleeps only after 5 minutes of complete silence,
// so TWO independent 15-minute timers that happen to be 7 minutes apart in phase wake the
// database every 7 minutes and it never sleeps again — the exact failure we are fixing, just with
// fewer requests. Everything that touches the database on a schedule must therefore land in the
// SAME window: the reader's flush, the reader's source refresh, and the external cron tick.
//
// The way to get that without any coordination between hosts is to fire on wall-clock boundaries:
// the next instant where (epoch ms) is a whole multiple of the interval. A `*/15` crontab fires at
// :00/:15/:30/:45 of the hour; every real timezone offset is a whole (or half) hour, so those
// instants are the same multiples of 15 minutes in epoch time. Two processes that never talk to
// each other end up inside the same few seconds.
//
// Intervals are expected to DIVIDE an hour (5, 10, 15, 20, 30, 60 min). A value that does not
// (7 min) still works and still spaces the calls correctly, but it will not coincide with a
// crontab schedule — which is the whole point of the alignment.

/**
 * Milliseconds from `nowMs` to the next wall-clock multiple of `intervalMs`.
 * Always strictly positive and at most `intervalMs`: exactly ON a boundary the answer is a full
 * interval (never 0), so a timer can never fire twice at the same instant.
 */
export function msUntilNextBoundary(nowMs: number, intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('schedule: intervalMs must be a positive number');
  }
  const rest = ((nowMs % intervalMs) + intervalMs) % intervalMs; // safe for a negative clock too
  return intervalMs - rest;
}

/** What startAlignedInterval needs from the outside world (injected so it can be tested). */
export interface AlignedTimerDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const REAL_TIMERS: AlignedTimerDeps = {
  now: Date.now,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Run `task` on every wall-clock boundary of `intervalMs`. Re-arms from the CURRENT time after
 * each run (never from the previous deadline), so a slow task delays the next window instead of
 * queueing up a burst of catch-up runs. Overlap is impossible: the next timer is armed only when
 * the previous run has settled. Returns a stop function.
 */
export function startAlignedInterval(
  intervalMs: number,
  task: () => Promise<void> | void,
  deps: AlignedTimerDeps = REAL_TIMERS,
): () => void {
  let handle: unknown = null;
  let stopped = false;

  const arm = (): void => {
    if (stopped) return;
    handle = deps.setTimer(() => {
      void (async () => {
        try {
          await task();
        } catch {
          // The task owns its own logging; a fault must never stop the schedule.
        }
        arm();
      })();
    }, msUntilNextBoundary(deps.now(), intervalMs));
  };

  arm();
  return () => {
    stopped = true;
    if (handle !== null) deps.clearTimer(handle);
  };
}
