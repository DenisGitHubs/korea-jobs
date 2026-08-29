// lib/korea/cron/tick.ts
//
// ONE scheduled entry for everything the backend has to do on a timer.
//
// WHY (owner incident 2026-08-19): a Neon compute sleeps only after 5 MINUTES of complete
// silence. That makes the number of SEPARATE schedules — not the number of queries — the thing
// that decides the bill. Six cron endpoints called at six different minutes wake the database six
// times, and if any two are less than five minutes apart it never sleeps at all. Which is exactly
// what happened: 110.26 of 100 CU-hours by Aug 19, the product dark for everybody until the
// billing period reset.
//
// So the scheduler now needs ONE call: POST /api/cron/tick. It runs the same work in one awake
// window. The individual /api/cron/* routes are NOT removed — they stay for a manual or debugging
// run, and for a targeted retry — they just stop being the normal way to drive the product.
//
// This continues a line the file already had: inactive-erase and scheduled were made tail steps
// of cleanup ("no separate schedule needed") long before the outage. This is the same idea taken
// to its end.
//
// ── THE TIME BUDGET IS THE HARD PART ────────────────────────────────────────────────────────
// Vercel kills a function at 60s (vercel.json maxDuration). A combined pass therefore MUST be
// able to stop halfway and leave the rest for the next tick. Two rules make that safe:
//   * a wall-clock budget of 45s (the same figure broadcast/run.ts and scheduled/run.ts use), and
//     a per-step RESERVE: a step is only STARTED when its reserve still fits in what is left.
//     A step is never interrupted mid-way — every one of them is idempotent and resumable, but
//     only at its own boundaries;
//   * whatever does not fit is REPORTED as skipped, not silently dropped. The next tick is 15
//     minutes away, and every step picks up exactly where it left off.
// HONEST LIMIT: the reserves are realistic, not worst-case. A step that blows far past its
// reserve (a Claude call sitting on the SDK's own 10-minute timeout, say) can still get the whole
// function killed. Nothing is corrupted when that happens — the work already committed stays
// committed and the rest is retried — but the run reports nothing. This is a known trade, not an
// oversight: the alternative (reserves large enough for the worst case) means the maintenance
// steps would never start at all.
//
// ── ORDER, AND WHY IT ROTATES ────────────────────────────────────────────────────────────────
// Data steps (parse, notify) are what users feel, so they normally go first. But "normally first"
// plus a tight budget equals "maintenance never runs", and maintenance here includes retention —
// deleting what we promised to delete. So once an hour (the tick that lands in the first quarter)
// the order flips and maintenance goes first. Stateless, deterministic, no extra storage.

import { runParse } from '../parser/run.js';
import { runNotify } from '../notify/run.js';
import { runDigest } from '../digest/run.js';
import { runCleanup } from '../cleanup/run.js';
import { runReferralConfirm } from '../referral/confirm.js';
import { runScheduledPosts } from '../scheduled/run.js';

/** Wall-clock ceiling for ONE combined pass, well under Vercel's 60s maxDuration. */
export const TICK_TIME_BUDGET_MS = 45_000;

/**
 * How many parse batches one tick may run. The parser handles `parser_batch_size` (20) raw
 * messages per call; the measured inflow is ~20-40 per quarter hour, so a single pass per tick is
 * break-even at best and the queue would slowly grow. Up to three passes give real headroom while
 * keeping the AI spend bounded per tick — and a pass only happens if the previous one actually
 * had something to do.
 */
export const PARSE_MAX_PASSES = 3;

export type TickStepName = 'parse' | 'notify' | 'scheduled' | 'digest' | 'cleanup' | 'referral-confirm';

/**
 * Time a step is allowed to need before it may be STARTED. Realistic, not worst-case (see the
 * honest-limit note in the header). Tune these together with the budget, never one alone.
 */
export const STEP_RESERVE_MS: Record<TickStepName, number> = {
  parse: 20_000, // one Claude call per batch
  notify: 15_000, // up to notify_send_cap DMs, paced 40ms apart
  scheduled: 10_000, // usually nothing is due
  digest: 5_000, // self-throttled: outside the Seoul morning it is two config reads
  cleanup: 20_000, // a dozen retention statements + the inactive-erase tail
  'referral-confirm': 10_000,
};

/** What users feel — the pipeline that turns a Telegram message into a card and a DM. */
export const DATA_STEPS: readonly TickStepName[] = ['parse', 'notify'];
/** Housekeeping: publications, the daily digest, retention/erasure, referral credits. */
export const MAINTENANCE_STEPS: readonly TickStepName[] = [
  'scheduled',
  'digest',
  'cleanup',
  'referral-confirm',
];

/**
 * True on the tick that lands in the first quarter of an hour. With a 15-minute schedule that is
 * exactly one tick per hour — the one where maintenance goes first so a busy pipeline can never
 * starve retention forever.
 */
export function maintenanceFirst(now: Date): boolean {
  return now.getUTCMinutes() < 15;
}

/** The order this tick will attempt. Deterministic from the clock, no stored state. */
export function stepOrder(now: Date): TickStepName[] {
  return maintenanceFirst(now)
    ? [...MAINTENANCE_STEPS, ...DATA_STEPS]
    : [...DATA_STEPS, ...MAINTENANCE_STEPS];
}

/** Injectable side-effects so the pass is unit-testable without a clock or a database. */
export interface TickDeps {
  now: () => number;
  runners: Record<TickStepName, () => Promise<unknown>>;
}

export const REAL_DEPS: TickDeps = {
  now: Date.now,
  runners: {
    parse: runParse,
    notify: runNotify,
    scheduled: runScheduledPosts,
    digest: runDigest,
    cleanup: runCleanup,
    'referral-confirm': runReferralConfirm,
  },
};

export interface TickResult {
  /** Steps that ran to completion this tick, in the order they ran. */
  ran: TickStepName[];
  /** Steps left for the next tick because their reserve did not fit. NOT a failure. */
  skipped: TickStepName[];
  /** Steps that threw. The tick goes on: one broken step must not cost the others. */
  failed: TickStepName[];
  /** Each step's own result, under its own name. */
  steps: Record<string, unknown>;
  elapsedMs: number;
  budgetMs: number;
  /** True when maintenance went first this tick (the hourly rotation). */
  maintenanceFirst: boolean;
}

/**
 * Run everything that is due, in one pass, inside one budget. Never throws: a step that fails is
 * recorded and the pass continues.
 */
export async function runTick(deps: TickDeps = REAL_DEPS): Promise<TickResult> {
  const startedAt = deps.now();
  const order = stepOrder(new Date(startedAt));
  const result: TickResult = {
    ran: [],
    skipped: [],
    failed: [],
    steps: {},
    elapsedMs: 0,
    budgetMs: TICK_TIME_BUDGET_MS,
    maintenanceFirst: maintenanceFirst(new Date(startedAt)),
  };

  const left = (): number => TICK_TIME_BUDGET_MS - (deps.now() - startedAt);

  for (const name of order) {
    if (left() < STEP_RESERVE_MS[name]) {
      // Not started, so nothing is half-done: the next tick takes it from the top.
      result.skipped.push(name);
      continue;
    }
    try {
      const out = await deps.runners[name]();
      result.ran.push(name);
      result.steps[name] = out;

      // The parser is the only step with a QUEUE behind it. While there is work and budget, keep
      // going: these extra passes cost no additional wake-up, and the alternative is a queue that
      // grows by a few messages every quarter hour until it is days behind.
      if (name === 'parse') {
        let passes = 1;
        let processed = (out as { processed?: unknown } | null)?.processed;
        while (
          typeof processed === 'number' &&
          processed > 0 &&
          passes < PARSE_MAX_PASSES &&
          left() >= STEP_RESERVE_MS.parse
        ) {
          const more = (await deps.runners.parse()) as { processed?: unknown };
          passes += 1;
          result.steps[`parse_${passes}`] = more;
          processed = more?.processed;
        }
      }
    } catch (err) {
      result.failed.push(name);
      result.steps[name] = { error: err instanceof Error ? err.message : String(err) };
      // eslint-disable-next-line no-console
      console.error(`[cron/tick] ${name} failed:`, err instanceof Error ? err.message : String(err));
    }
  }

  result.elapsedMs = deps.now() - startedAt;
  return result;
}
