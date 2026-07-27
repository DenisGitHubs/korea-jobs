// lib/korea/cleanup/inactive.ts
//
// ERASURE OF A PERSON'S DATA — one implementation, two triggers:
//   * runInactiveErase() — the automatic sweep behind the Privacy Policy sentence «удаляем
//     данные через 12 месяцев без входа»;
//   * eraseUsers()       — the SAME erasure applied to named accounts, used by the admin
//     "delete my data" endpoint (lib/korea/admin/erase.ts) behind the OTHER Privacy Policy
//     promise: «выполняем просьбу об удалении в течение 3 рабочих дней».
// Both go through eraseUsers, so an on-request deletion can never take a different (or a more
// dangerous) path than the sweep — that is the whole point of the split (007, major).
// Without this file those two sentences would be promises the product does not keep.
//
// WHAT COUNTS AS "A LOGIN"
//   users.last_seen_at. It is stamped now() by EVERY authenticated Mini App request (the
//   upsert in core/context.ts) and by every /start in the bot (bot/webhook.ts) — both paths
//   were already writing that row, so the signal costs nothing extra and needs no new column.
//   Reading a DM is NOT a login (we cannot observe it); tapping the button in that DM opens
//   the app and IS one.
//
// THE SCHEME — «стереть личное, оставить пустой узел» (a tombstone, not a hole)
//   The naive `delete from users` is UNSAFE here, and not because of the person leaving:
//   referral_points_ledger.activation_id -> referral_activations(id) ON DELETE CASCADE, and
//   referral_activations.user_id -> users(id) ON DELETE CASCADE. So deleting ONE dormant
//   invitee would cascade into the credits their INVITER earned and silently shrink a third
//   party's balance (the balance IS the ledger — draft_0004). Three other aggregates read the
//   graph the same way (referred_by / ref_l2 / ref_l3 counters).
//   Therefore the sweep:
//     1. DELETES everything that is the person's own data — subscriptions, saved_vacancies,
//        saved_ads, contact_reveals, ad_contact_reveals, raw_contact_reveals,
//        notifications_sent, vacancy_reports, streak_awards, cooperation_requests, their own
//        referral_points_ledger credits (their balance dies with them), their user_ads (so the
//        ad leaves the feed — the delete cascades its reveals/bookmarks), and the two ledgers
//        keyed on their RAW telegram id: bot_updates and bot_inbox (007 minor — the inbox ledger
//        holds no message text, but a telegram id is still a person);
//     2. STRIPS the users row itself of every identifier — telegram_id, username, first_name,
//        last_name — rotates public_id (any referral link they ever shared stops resolving),
//        clears consent/onboarding/streak state, and stamps deleted_at;
//     3. KEEPS exactly two things, both free of personal data: the referral_activations row
//        (the anchor the inviter's credits hang on) and the ancestor pointers
//        (referred_by / ref_l2 / ref_l3), so nobody else's chain or counter moves.
//   What is left is an anonymous node: no identifier, no content, nothing that points back to
//   a person. If they ever come back, they arrive as a brand-new account — which is exactly
//   what "your data was deleted" means.
//
// SAFETY PROPERTIES
//   * OFF BY DEFAULT (config inactive_delete_enabled, seeded false in draft_0027). While it is
//     false this function reads one cached config value and returns — it cannot touch a row.
//   * The term is clamped to 1..120 months in code, so a fat-fingered `0` in config can never
//     turn the sweep into "erase everybody".
//   * Admins (role='admin') are never swept.
//   * IDEMPOTENT: candidates are `deleted_at is null` only, and every statement is a
//     `delete ... where user_id = any($1)`. Re-running finds nothing to do. If a tick dies
//     halfway, the users row is still un-stamped, so the next tick simply redoes that account
//     (dependents are deleted FIRST, the stamp LAST — never the other way round).
//   * BATCHED: `inactive_delete_batch` accounts per batch (default 200), at most
//     `inactive_delete_max_batches` batches per tick (default 5) and a wall-clock budget, so no
//     statement is ever long enough to sit on a lock or hit the statement timeout.

import { getSql } from '../core/db.js';
import { getConfigBool, getConfigNumber } from '../config.js';

type Sql = ReturnType<typeof getSql>;

/** Wall-clock ceiling for ONE tick. Checked BEFORE each batch, never mid-batch. */
export const INACTIVE_ERASE_TIME_BUDGET_MS = 20_000;

export const MONTHS_MIN = 1;
export const MONTHS_MAX = 120;
export const BATCH_MIN = 1;
export const BATCH_MAX = 1000;
export const MAX_BATCHES_MIN = 1;
export const MAX_BATCHES_MAX = 50;

export interface InactiveEraseDeps {
  now: () => number;
}

const REAL_DEPS: InactiveEraseDeps = { now: Date.now };

/** Rows removed by one erasure, by group (for the ops log — no identifiers, just counts). */
export interface EraseCounts {
  /** Accounts whose personal data was erased (the users row stripped + stamped). */
  usersErased: number;
  adsDeleted: number;
  subscriptionsDeleted: number;
  savedDeleted: number;
  revealsDeleted: number;
  notificationsDeleted: number;
  ledgerDeleted: number;
  reportsDeleted: number;
  streakAwardsDeleted: number;
  cooperationDeleted: number;
  botUpdatesDeleted: number;
  /** Rows dropped from the bot inbox anti-spam ledger (keyed on the raw telegram id). */
  botInboxDeleted: number;
}

export interface InactiveEraseResult extends EraseCounts {
  /** False = the master switch is off; NOTHING was read or written beyond the config. */
  enabled: boolean;
  /** The term actually applied, after clamping (months). */
  months: number;
  /** How many batches this tick processed. */
  batches: number;
  stoppedReason: 'disabled' | 'done' | 'budget' | 'max_batches';
}

/** A zeroed counter set — the shape every erasure reports (and what "nothing happened" looks like). */
export function emptyEraseCounts(): EraseCounts {
  return {
    usersErased: 0,
    adsDeleted: 0,
    subscriptionsDeleted: 0,
    savedDeleted: 0,
    revealsDeleted: 0,
    notificationsDeleted: 0,
    ledgerDeleted: 0,
    reportsDeleted: 0,
    streakAwardsDeleted: 0,
    cooperationDeleted: 0,
    botUpdatesDeleted: 0,
    botInboxDeleted: 0,
  };
}

/** Add one erasure's counters into a running total (the sweep accumulates across batches). */
function addCounts(total: EraseCounts, one: EraseCounts): void {
  total.usersErased += one.usersErased;
  total.adsDeleted += one.adsDeleted;
  total.subscriptionsDeleted += one.subscriptionsDeleted;
  total.savedDeleted += one.savedDeleted;
  total.revealsDeleted += one.revealsDeleted;
  total.notificationsDeleted += one.notificationsDeleted;
  total.ledgerDeleted += one.ledgerDeleted;
  total.reportsDeleted += one.reportsDeleted;
  total.streakAwardsDeleted += one.streakAwardsDeleted;
  total.cooperationDeleted += one.cooperationDeleted;
  total.botUpdatesDeleted += one.botUpdatesDeleted;
  total.botInboxDeleted += one.botInboxDeleted;
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Math.trunc(Number.isFinite(n) ? n : lo)));

/**
 * Run a DELETE and get back ONLY its row count. `with d as (delete ... returning 1)
 * select count(*)` keeps the response one row wide — a plain `returning id` would ship
 * thousands of ids (a chatty account's notifications_sent) over the wire for nothing.
 */
function countOf(rows: Record<string, unknown>[]): number {
  const n = rows[0]?.n;
  return typeof n === 'number' ? n : Number(n ?? 0) || 0;
}

/**
 * One account to erase: the users row id plus its RAW telegram id (or null when the row has none).
 * The telegram id travels WITH the target because two ledgers — bot_updates and bot_inbox — have
 * no foreign key to users (a person can write to the bot before any users row exists), so they can
 * only be cleared by that id, and after step 2 the id is gone from the users row forever.
 */
export interface EraseTarget {
  id: string;
  tid: string | null;
}

type Candidate = EraseTarget;

/**
 * Clear the two ledgers that key on a RAW telegram id and have NO foreign key to users:
 *   * bot_updates — the webhook's own dedup/rate-limit ledger (draft_0001);
 *   * bot_inbox   — the «написали в бот» anti-spam ledger (draft_0028). It stores no message
 *     text, but sender/chat ids ARE personal data and its own 30-day retention would outlive an
 *     erasure (007 minor).
 * Exported because a person may exist ONLY here: someone who wrote to the bot but never opened
 * the Mini App has no users row at all, and "delete my data" must still mean something for them
 * (admin/erase.ts). Empty list = no statements. bot_inbox is best-effort: a missing table in a
 * deploy-before-migrate window must never fail a person's erasure.
 */
export async function eraseBotLedgers(
  sql: Sql,
  tids: string[],
): Promise<{ botUpdatesDeleted: number; botInboxDeleted: number }> {
  const out = { botUpdatesDeleted: 0, botInboxDeleted: 0 };
  if (tids.length === 0) return out;

  out.botUpdatesDeleted += countOf(await sql`
    with d as (delete from bot_updates where from_id = any(${tids}::bigint[]) returning 1)
    select count(*)::int as n from d`);

  try {
    out.botInboxDeleted += countOf(await sql`
      with d as (delete from bot_inbox where from_id = any(${tids}::bigint[]) returning 1)
      select count(*)::int as n from d`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      '[erase] bot_inbox cleanup failed (table missing?):',
      err instanceof Error ? err.message : String(err),
    );
  }
  return out;
}

/**
 * ERASE a batch of accounts. THE single implementation of «стереть личное, оставить пустой узел»
 * (see the file header for the scheme and why a plain `delete from users` is unsafe here).
 *
 * Callers: the inactivity sweep below, and the admin on-request deletion
 * (lib/korea/admin/erase.ts). Same statements, same order, same guarantees:
 *   * dependents FIRST, the users stamp LAST — a crash in the middle leaves the account
 *     un-stamped, so the next run simply redoes it;
 *   * `and deleted_at is null` on the stamp → running it twice erases once;
 *   * referral_activations and the ancestor pointers are never touched, so no third party's
 *     balance or chain moves.
 * An empty list is a no-op (not a single statement is issued).
 */
export async function eraseUsers(sql: Sql, targets: EraseTarget[]): Promise<EraseCounts> {
  const counts = emptyEraseCounts();
  if (targets.length === 0) return counts;

  const ids = targets.map((c) => c.id);
  const tids = targets
    .map((c) => c.tid)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);

  // ── 1. The person's own rows. Dependents FIRST, the users stamp LAST: if this dies in the
  //       middle, the account stays un-stamped and the next run redoes it from the top.
  counts.notificationsDeleted += countOf(await sql`
    with d as (delete from notifications_sent where user_id = any(${ids}::uuid[]) returning 1)
    select count(*)::int as n from d`);

  counts.revealsDeleted += countOf(await sql`
    with d as (delete from contact_reveals where user_id = any(${ids}::uuid[]) returning 1)
    select count(*)::int as n from d`);
  counts.revealsDeleted += countOf(await sql`
    with d as (delete from ad_contact_reveals where user_id = any(${ids}::uuid[]) returning 1)
    select count(*)::int as n from d`);
  counts.revealsDeleted += countOf(await sql`
    with d as (delete from raw_contact_reveals where user_id = any(${ids}::uuid[]) returning 1)
    select count(*)::int as n from d`);

  counts.savedDeleted += countOf(await sql`
    with d as (delete from saved_vacancies where user_id = any(${ids}::uuid[]) returning 1)
    select count(*)::int as n from d`);
  counts.savedDeleted += countOf(await sql`
    with d as (delete from saved_ads where user_id = any(${ids}::uuid[]) returning 1)
    select count(*)::int as n from d`);

  counts.reportsDeleted += countOf(await sql`
    with d as (delete from vacancy_reports where user_id = any(${ids}::uuid[]) returning 1)
    select count(*)::int as n from d`);

  counts.streakAwardsDeleted += countOf(await sql`
    with d as (delete from streak_awards where user_id = any(${ids}::uuid[]) returning 1)
    select count(*)::int as n from d`);

  // Free text the person typed (contact + message) — theirs, so it goes.
  counts.cooperationDeleted += countOf(await sql`
    with d as (delete from cooperation_requests where user_id = any(${ids}::uuid[]) returning 1)
    select count(*)::int as n from d`);

  counts.subscriptionsDeleted += countOf(await sql`
    with d as (delete from subscriptions where user_id = any(${ids}::uuid[]) returning 1)
    select count(*)::int as n from d`);

  // THEIR OWN credits only (user_id = recipient). Rows where they merely appear as
  // source_user_id belong to their INVITER and are left alone — that FK is ON DELETE SET
  // NULL, so the inviter keeps the points and simply loses the pointer. referral_activations
  // is NOT deleted here: its cascade would take the inviter's ledger rows with it.
  counts.ledgerDeleted += countOf(await sql`
    with d as (delete from referral_points_ledger where user_id = any(${ids}::uuid[]) returning 1)
    select count(*)::int as n from d`);

  // Their ads leave the FEED for good (cascades ad_contact_reveals / saved_ads /
  // notifications_sent rows that pointed at them).
  counts.adsDeleted += countOf(await sql`
    with d as (delete from user_ads where author_user_id = any(${ids}::uuid[]) returning 1)
    select count(*)::int as n from d`);

  // The two bot ledgers key on the RAW telegram id (no FK to users), so they must be cleared by
  // that id, not by user_id — and only while we still have it (step 2 removes it for good).
  const ledgers = await eraseBotLedgers(sql, tids);
  counts.botUpdatesDeleted += ledgers.botUpdatesDeleted;
  counts.botInboxDeleted += ledgers.botInboxDeleted;

  // ── 2. The stamp. Every identifier is removed; public_id is rotated so any referral link
  //       this account ever shared stops resolving. What survives — id, created_at,
  //       referred_by/ref_l2/ref_l3 — is an anonymous node other people's chains depend on.
  //       `and deleted_at is null` keeps the statement idempotent under a concurrent run.
  counts.usersErased += countOf(await sql`
    with d as (
      update users set
        telegram_id        = null,
        username           = null,
        first_name         = null,
        last_name          = null,
        public_id          = encode(gen_random_bytes(8), 'hex'),
        lang               = 'ru',
        allows_write_to_pm = false,
        is_blocked         = false,
        onboarded_at       = null,
        terms_accepted_at  = null,
        terms_version      = null,
        visit_streak       = 0,
        visit_streak_day   = null,
        open_streak        = 0,
        open_streak_day    = null,
        deleted_at         = now()
      where id = any(${ids}::uuid[]) and deleted_at is null
      returning 1)
    select count(*)::int as n from d`);

  return counts;
}

/**
 * Erase the personal data of accounts dormant for `inactive_delete_months`.
 * Guarded by the `inactive_delete_enabled` master switch (default OFF).
 */
export async function runInactiveErase(
  deps: InactiveEraseDeps = REAL_DEPS,
): Promise<InactiveEraseResult> {
  const months = clamp(await getConfigNumber('inactive_delete_months', 12), MONTHS_MIN, MONTHS_MAX);

  const result: InactiveEraseResult = {
    ...emptyEraseCounts(),
    enabled: false,
    months,
    batches: 0,
    stoppedReason: 'disabled',
  };

  // MASTER SWITCH. Read FIRST and bail before any query: while it is false this function is
  // physically incapable of deleting anything (owner turns it on after a dry run).
  if (!(await getConfigBool('inactive_delete_enabled', false))) return result;
  result.enabled = true;
  result.stoppedReason = 'done';

  const batchSize = clamp(await getConfigNumber('inactive_delete_batch', 200), BATCH_MIN, BATCH_MAX);
  const maxBatches = clamp(
    await getConfigNumber('inactive_delete_max_batches', 5),
    MAX_BATCHES_MIN,
    MAX_BATCHES_MAX,
  );

  const sql = getSql();
  const startedAt = deps.now();

  for (let batch = 0; batch < maxBatches; batch++) {
    if (deps.now() - startedAt > INACTIVE_ERASE_TIME_BUDGET_MS) {
      result.stoppedReason = 'budget';
      break;
    }

    // Candidates: LIVE accounts (deleted_at is null — this is what makes the sweep idempotent),
    // never an admin, dormant for the whole term. `created_at` is checked too: a row created
    // yesterday can never be swept even if last_seen_at were somehow bogus. Oldest first, so a
    // backlog drains in a stable order.
    const candidates = (await sql`
      select id, telegram_id::text as tid
      from users
      where deleted_at is null
        and role <> 'admin'
        and last_seen_at < now() - make_interval(months => ${months})
        and created_at   < now() - make_interval(months => ${months})
      order by last_seen_at asc
      limit ${batchSize}`) as unknown as Candidate[];

    if (candidates.length === 0) break;
    result.batches += 1;

    // The erasure itself is SHARED with the on-request path (admin/erase.ts) — same statements,
    // same order, one place to audit.
    addCounts(result, await eraseUsers(sql, candidates));

    // A short batch means the backlog is drained — stop before paying for another scan.
    if (candidates.length < batchSize) break;
    if (batch === maxBatches - 1) result.stoppedReason = 'max_batches';
  }

  return result;
}
