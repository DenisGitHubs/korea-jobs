// lib/korea/broadcast/run.ts
//
// Admin broadcast tool (owner request 2026-07-21). The owner DMs the bot
//   /broadcast <text>
// in a private chat; the webhook (bot/webhook.ts) stores a DRAFT in `broadcasts`, shows a
// preview with [Отправить]/[Отмена], and on confirm claims the row ATOMICALLY and runs the
// send loop here. This module owns every broadcast DB touch + the send loop + the pure text
// helpers, so the webhook stays thin.
//
// SAFETY MODEL:
//   * Anti-double-send is the row state machine, not a flag: claimBroadcast() does
//     `update ... set status='sent' where id=? and status='draft' returning text`. Exactly one
//     concurrent/re-tapped caller gets the row (Postgres re-checks the WHERE after the row lock
//     under READ COMMITTED); everyone else gets null and MUST NOT send. The claim happens
//     BEFORE the loop, so even a mid-loop function timeout can never resend.
//   * plain text, NO parse_mode anywhere — the body is arbitrary admin input; letting Telegram
//     parse it as Markdown/HTML would break on stray '_', '*', '<' and is an injection surface.
//   * A 403 during the loop flips users.is_blocked (same signal as the notify worker); a
//     transient error / transport throw / 429 is counted as skipped with NO retry — this is a
//     one-shot manual broadcast and the final report shows the gap (owner design).
//
// SCALE NOTE (Vercel maxDuration 60s): the loop runs INSIDE the callback handler with a 40ms gap
// per recipient. TWO guards keep a single run inside the platform budget and always leave a
// truthful trail:
//   * a hard TIME BUDGET (BROADCAST_TIME_BUDGET_MS = 45s): the loop checks wall-clock elapsed
//     BEFORE each send and bails cleanly if it would overrun. It is the REAL network round-trip of
//     sendMessage — not just the 40ms sleep — that can blow past maxDuration and kill the function
//     mid-loop, so wall-clock is the only honest guard. sent_n/skipped_n are written REGARDLESS of
//     how the loop ends, so a run is never a silent NULL that cannot be reported or repeated.
//   * a recipient CAP (config broadcast_send_cap, default 300 — deliberately conservative until
//     this moves to a decoupled worker; a DB config value overrides): an upper bound on rows
//     fetched per run.
// Whatever these two leave unreached is reported to the admin honestly (see resultText). A larger
// audience needs a cron worker like notify/run.ts — out of scope for this manual tool.

import { getSql } from '../core/db.js';
import { getConfigNumber } from '../config.js';
import { sendMessage, isUserUnavailable, maskToken, type TgResponse } from '../bot/telegram.js';

type Sql = ReturnType<typeof getSql>;

/** UTF-16 code units. Bot API sendMessage caps text at 4096; 3800 leaves headroom for the
 *  preview wrapper ("Предпросмотр:\n\n" + text + "\n\nОтправить всем (N получателей)?"). */
export const BROADCAST_TEXT_MAX = 3800;

/** Default hard cap on recipients per single broadcast run (config: broadcast_send_cap).
 *  Conservative (007 rec.) until the broadcast moves to a background worker; DB config overrides. */
export const BROADCAST_SEND_CAP_DEFAULT = 300;

/** Hard wall-clock budget for ONE in-request send loop, well under Vercel's 60s maxDuration. The
 *  loop checks elapsed before each send and exits cleanly rather than being killed mid-write. */
export const BROADCAST_TIME_BUDGET_MS = 45_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (DB-free, unit-tested).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The broadcast body = everything after the first whitespace-delimited token. Strips
 * `/broadcast` AND the `/broadcast@BotName` form (the whole first token), then trims the
 * edges — INTERNAL newlines are preserved (a multi-line broadcast stays multi-line).
 * Returns '' when only the command was sent.
 */
export function broadcastBody(text: string): string {
  const firstToken = text.split(/\s+/, 1)[0] ?? '';
  return text.slice(firstToken.length).trim();
}

/** The admin-facing preview: the exact body framed for confirmation. plain text. */
export function previewText(body: string, recipients: number): string {
  return `Предпросмотр:\n\n${body}\n\nОтправить всем (${recipients} получателей)?`;
}

/**
 * The final report edited onto the preview message once the loop ends. When not everyone was
 * reached (the audience exceeded the cap, or the loop hit its time budget) a second, plain-language
 * line spells out the exact gap so the admin is never misled by a "N из N" that hides it.
 */
export function resultText(r: BroadcastRunResult): string {
  const base = `Отправлено ${r.sent} из ${r.total} (пропущено ${r.skipped})`;
  const reached = r.sent + r.skipped;
  if (reached >= r.total) return base;
  const why =
    r.stoppedReason === 'timeout'
      ? 'не успели разослать всем за один заход'
      : 'за один раз уходит ограниченное число';
  return `${base}\n⚠️ Не все получили: успели ${reached} из ${r.total} — ${why}.`;
}

export interface BroadcastCallback {
  action: 'send' | 'cancel';
  id: string;
}

const BROADCAST_CB_RE =
  /^bc:(send|cancel):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Parse a `bc:send:<uuid>` / `bc:cancel:<uuid>` callback, or null if it is not one. */
export function parseBroadcastCallback(data: string): BroadcastCallback | null {
  const m = BROADCAST_CB_RE.exec(data);
  if (!m) return null;
  return { action: m[1]!.toLowerCase() as 'send' | 'cancel', id: m[2]! };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers (thin, so the webhook holds no broadcast SQL).
// ─────────────────────────────────────────────────────────────────────────────

/** Insert a DRAFT broadcast, returning its id. The caller has already length-checked `body`. */
export async function insertBroadcastDraft(sql: Sql, body: string): Promise<string> {
  const rows = (await sql`
    insert into broadcasts (text) values (${body}) returning id`) as unknown as { id: string }[];
  return rows[0]!.id;
}

/** How many users a broadcast would reach right now: PM-writable and not known-blocked. */
export async function countRecipients(sql: Sql): Promise<number> {
  const rows = (await sql`
    select count(*)::int as n from users
    where allows_write_to_pm and not is_blocked`) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

/**
 * ATOMICALLY claim a draft for sending. Returns the text on success (exactly one caller), or
 * null when the row is not a draft (already sent/cancelled) — the anti-double-send guard.
 */
export async function claimBroadcast(sql: Sql, id: string): Promise<string | null> {
  const rows = (await sql`
    update broadcasts set status = 'sent', sent_at = now()
    where id = ${id}::uuid and status = 'draft'
    returning text`) as unknown as { text: string }[];
  return rows.length > 0 ? rows[0]!.text : null;
}

/** Cancel a draft (only while still a draft). Returns true when it flipped to 'cancelled'. */
export async function cancelBroadcast(sql: Sql, id: string): Promise<boolean> {
  const rows = (await sql`
    update broadcasts set status = 'cancelled'
    where id = ${id}::uuid and status = 'draft'
    returning id`) as unknown as { id: string }[];
  return rows.length > 0;
}

/** Why the run stopped: everyone reached ('done'), the recipient cap ('cap'), or the time budget. */
export type BroadcastStopReason = 'done' | 'cap' | 'timeout';

export interface BroadcastRunResult {
  total: number; // FULL eligible audience at send time (NOT capped) — the honest denominator
  sent: number; // Bot API accepted the message
  skipped: number; // 403 (blocked) + transient/transport/429, no retry
  notReached: number; // eligible recipients not attempted this run (cap or time budget)
  stoppedReason: BroadcastStopReason;
}

/** One eligible recipient: internal user id + telegram_id as text (bigint-safe). */
export interface Recipient {
  id: string;
  tid: string;
}

/** Injectable side-effects so the send loop is unit-testable without the Bot API / real clock. */
export interface BroadcastDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  send: (tid: string, text: string) => Promise<TgResponse<{ message_id: number }>>;
}

const REAL_DEPS: BroadcastDeps = { now: Date.now, sleep, send: sendMessage };

export interface DeliveryLoopResult {
  sent: number;
  skipped: number;
  /** True when the loop exited early because it ran out of its wall-clock budget. */
  stoppedByBudget: boolean;
}

/**
 * The actual per-recipient send loop, extracted from runBroadcast so it can be unit-tested with an
 * injected clock/sender (no Postgres, no real 45s wait). Delivers `text` (plain text, no
 * parse_mode), pacing `deps.sleep(40)` between sends. Before EACH send it checks the wall-clock
 * budget and bails cleanly if it would overrun — the real network RTT, not just the sleep, is what
 * can push a large run past maxDuration. A per-recipient failure never aborts the loop (a throw is
 * caught → skipped); a failed is_blocked flag on a 403 is best-effort and also never aborts, so one
 * bad chat / one DB blip cannot strand the rest. This loop NEVER throws.
 */
export async function runDeliveryLoop(
  recipients: Recipient[],
  text: string,
  markBlocked: (id: string) => Promise<void>,
  deps: BroadcastDeps,
  budgetMs: number,
): Promise<DeliveryLoopResult> {
  const start = deps.now();
  let sent = 0;
  let skipped = 0;
  let stoppedByBudget = false;

  for (const r of recipients) {
    if (deps.now() - start > budgetMs) {
      // Out of time — stop BEFORE starting another send so the caller can persist what we have and
      // report the gap, instead of the function being killed mid-write with NULL metrics.
      stoppedByBudget = true;
      break;
    }
    try {
      const resp = await deps.send(r.tid, text); // plain text — NO parse_mode
      if (resp.ok) {
        sent += 1;
      } else if (isUserUnavailable(resp)) {
        skipped += 1;
        try {
          await markBlocked(r.id);
        } catch {
          // Flipping is_blocked is best-effort bookkeeping; a blip here must not abort the run.
        }
      } else {
        // transient / 429 / unknown Bot API error — no retry (manual one-shot; report shows it)
        skipped += 1;
      }
    } catch {
      // transport/timeout throw (token already masked by telegram.ts) — count and continue
      skipped += 1;
    }
    await deps.sleep(40); // ~25 msg/s, under the global 30/s Bot API ceiling
  }

  return { sent, skipped, stoppedByBudget };
}

/**
 * Deliver `text` to every eligible recipient. The `broadcasts` row is ALREADY claimed 'sent' by
 * claimBroadcast before this runs. Computes the honest `total` (full eligible count, NOT the cap),
 * runs the send loop under a hard time budget, ALWAYS persists sent_n/skipped_n (even on a
 * cap/budget short-fall, and even if that persist itself fails we keep the numbers), and returns
 * the tally plus how many were left unreached and why. `deps` is injected only in tests.
 */
export async function runBroadcast(
  sql: Sql,
  id: string,
  text: string,
  deps: BroadcastDeps = REAL_DEPS,
): Promise<BroadcastRunResult> {
  const cap = await getConfigNumber('broadcast_send_cap', BROADCAST_SEND_CAP_DEFAULT);

  // The honest denominator: the FULL eligible audience at send time (NOT capped). The report uses
  // this so a big audience can never show a false "N из N" that hides the untouched tail.
  const total = await countRecipients(sql);

  // Oldest-first, capped. If total > cap the tail is not reached in one run (documented limit of
  // this manual tool — see the SCALE NOTE at the top); the report shows the gap honestly.
  const recipients = (await sql`
    select id, telegram_id::text as tid from users
    where allows_write_to_pm and not is_blocked
    order by created_at asc
    limit ${cap}`) as unknown as Recipient[];

  const markBlocked = async (uid: string): Promise<void> => {
    await sql`update users set is_blocked = true where id = ${uid}::uuid`;
  };

  const loop = await runDeliveryLoop(recipients, text, markBlocked, deps, BROADCAST_TIME_BUDGET_MS);

  // ALWAYS record the tally — even on a cap/budget short-fall — so /stats and the report stay
  // truthful and the run is never a silent NULL. The row is already claimed 'sent'; if this metrics
  // write itself fails we must NOT throw away the numbers we already have, so swallow+log (token
  // masked) and still return them — the admin still sees N/M in the report.
  try {
    await sql`update broadcasts set sent_n = ${loop.sent}, skipped_n = ${loop.skipped} where id = ${id}::uuid`;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[broadcast] metrics persist failed:', maskToken(String(err)));
  }

  const reached = loop.sent + loop.skipped;
  const notReached = Math.max(0, total - reached);
  const stoppedReason: BroadcastStopReason =
    notReached === 0 ? 'done' : loop.stoppedByBudget ? 'timeout' : 'cap';

  return { total, sent: loop.sent, skipped: loop.skipped, notReached, stoppedReason };
}
