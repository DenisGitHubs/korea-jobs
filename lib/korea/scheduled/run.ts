// lib/korea/scheduled/run.ts
//
// The publishing worker of the owner's «отложенные публикации» tool: it takes the schedules that
// have come due (scheduled_posts.status='active', next_run_at <= now()) and turns each one into a
// REAL user_ads row, exactly as if it had been posted by hand at that minute.
//
// IDEMPOTENCY — the reason this file is shaped the way it is.
// A cron tick can be duplicated (the scheduler retries, two serverless invocations overlap, the
// same run is also driven from the tail of /api/cron/cleanup). So publishing is CLAIM-FIRST:
//   1. insert scheduled_post_runs (schedule_id, run_no) — the PRIMARY KEY is the idempotency key;
//   2. only the caller that won the insert publishes;
//   3. everyone else gets 0 rows and skips.
// A run row is re-claimable ONLY when it previously FAILED or is a STALE 'running' (an invocation
// that died mid-flight — see STALE_RUN_MINUTES). A run already 'done' is never republished; if the
// schedule's bookkeeping did not survive that publication (a crash between step 2 and the advance),
// the next tick HEALS it from the journal instead of publishing a second copy.
//
// REPEATS DO NOT FAKE FRESHNESS (Законник, owner-approved). A repeat is NOT a bump: it publishes a
// NEW card and ARCHIVES every earlier publication of the same schedule (status='archived'), so the
// feed never accumulates duplicates of one offer and no old card is re-dated to look fresh.
//
// PROMO NEVER REACHES A DM. A kind='promo' row is published with promo=true and notify_pending=FALSE,
// whatever the schedule says — a paid placement lives in the feed and nowhere else. This is the third
// of four independent guards (parser → store → HERE → notify/run.ts), because a paid ad that landed
// in somebody's private messages is precisely the failure this rule exists to prevent.
//
// TIME BUDGET. The worker runs inside a normal serverless request, so it publishes at most
// `scheduled_batch` schedules per tick and checks a wall-clock budget before each one; whatever is
// left over simply stays due and goes out on the next tick (next_run_at is untouched).

import { getSql } from '../core/db.js';
import { getConfigNumber, getConfigBool } from '../config.js';
import { sendMessage, maskToken } from '../bot/telegram.js';
import { formatSeoul } from './parse.js';
import type { StoredPayload } from './store.js';

type Sql = ReturnType<typeof getSql>;

/** Schedules published per tick (config: scheduled_batch). */
export const SCHEDULED_BATCH_DEFAULT = 5;
/** Consecutive failures after which a schedule is parked as 'failed' (config: scheduled_max_fails). */
export const SCHEDULED_MAX_FAILS_DEFAULT = 3;
/** How long a 'running' run row may sit before another invocation may re-claim it (a dead function). */
export const STALE_RUN_MINUTES = 10;
/** Backoff before retrying a schedule whose publication just failed. */
export const RETRY_AFTER_MINUTES = 5;
/** Hard wall-clock budget for ONE tick, well under Vercel's 60s maxDuration. */
export const SCHEDULED_TIME_BUDGET_MS = 45_000;
/** last_error / run.error are diagnostics, not a log dump. */
export const ERROR_TEXT_MAX = 500;

export interface ScheduledRunResult {
  /** Schedules that were due and examined this tick. */
  due: number;
  /** Publications actually made (one per claimed run). */
  published: number;
  /** Publications that failed (the schedule is retried, or parked as 'failed'). */
  failed: number;
  /** Schedules that made their LAST planned publication this tick. */
  finished: number;
  /** Due schedules skipped: claimed by a concurrent tick, or healed from an already-'done' run. */
  skipped: number;
}

/** One due schedule, as the worker reads it. */
interface DueRow {
  id: string;
  kind: string;
  payload: unknown;
  media_id: string | null;
  created_by: string | null;
  total_runs: number;
  done_runs: number;
  notify: boolean;
}

/** Injectable side-effects so the worker is unit-testable without a real clock / the Bot API. */
export interface ScheduledDeps {
  now: () => number;
  send: (chatId: string, text: string) => Promise<unknown>;
}

const REAL_DEPS: ScheduledDeps = { now: Date.now, send: (chatId, text) => sendMessage(chatId, text) };

/** Payload defaults — a hand-edited row must never be able to crash the worker on a missing key. */
function readPayload(raw: unknown): StoredPayload {
  const p = (typeof raw === 'string' ? safeJson(raw) : raw) as Partial<StoredPayload> | null;
  return {
    title: typeof p?.title === 'string' ? p.title : '',
    description: typeof p?.description === 'string' ? p.description : '',
    contact_raw: typeof p?.contact_raw === 'string' ? p.contact_raw : null,
    contact_kind: typeof p?.contact_kind === 'string' ? p.contact_kind : null,
    work_type: typeof p?.work_type === 'string' ? p.work_type : 'other',
    city_slug: typeof p?.city_slug === 'string' ? p.city_slug : null,
    city_text: typeof p?.city_text === 'string' ? p.city_text : null,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Error text for a column / an owner DM: masked (never a token) and clipped. */
export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return maskToken(msg).slice(0, ERROR_TEXT_MAX);
}

/**
 * CLAIM one run. Returns true only for the caller that owns the publication.
 *
 * The insert IS the lock: PK (schedule_id, run_no). The ON CONFLICT branch re-opens a run only when
 * it previously FAILED, or when it is a 'running' left behind by an invocation that died
 * (ran_at older than STALE_RUN_MINUTES) — a 'done' run is never handed out again.
 */
export async function claimRun(sql: Sql, scheduleId: string, runNo: number): Promise<boolean> {
  const rows = (await sql`
    insert into scheduled_post_runs (schedule_id, run_no, status)
    values (${scheduleId}::uuid, ${runNo}, 'running')
    on conflict (schedule_id, run_no) do update
      set status = 'running', ran_at = now(), error = null
      where scheduled_post_runs.status = 'failed'
         or (scheduled_post_runs.status = 'running'
             and scheduled_post_runs.ran_at < now() - make_interval(mins => ${STALE_RUN_MINUTES}))
    returning run_no`) as unknown as { run_no: number }[];
  return rows.length > 0;
}

/** The status of a run row we could not claim ('done' = it was already published). */
async function runStatus(sql: Sql, scheduleId: string, runNo: number): Promise<string | null> {
  const rows = (await sql`
    select status from scheduled_post_runs
    where schedule_id = ${scheduleId}::uuid and run_no = ${runNo}
    limit 1`) as unknown as { status: string }[];
  return rows[0]?.status ?? null;
}

/**
 * Publish ONE run as an ordinary approved user ad and return its id.
 *
 * The city is resolved IN SQL from the slug the owner's «город» already resolved to at scheduling
 * time (store.resolveCity): city_id + city_ids + region_slug + region_slugs, so the card is reachable
 * by the city AND the region filter. An unrecognised city stays free text (city_text), exactly like
 * the "Другое" city of the mini-app form.
 *
 * notify_pending is true ONLY for kind='ad' with notify=true. For a promo it is FALSE, always.
 */
export async function publishRun(
  sql: Sql,
  s: DueRow,
  payload: StoredPayload,
  ttlDays: number,
): Promise<string | null> {
  const promo = s.kind === 'promo';
  const notifyPending = !promo && s.notify === true;
  const rows = (await sql`
    with c as (
      select id, region_slug from cities where slug = ${payload.city_slug}::text and is_active limit 1
    )
    insert into user_ads (
      author_user_id, city_id, city_ids, city_text, region_slug, region_slugs,
      work_type, title, description, contact_raw, contact_kind,
      media_id, promo, status, moderated_at, expires_at, notify_pending
    )
    select ${s.created_by}::uuid,
           (select id from c),
           coalesce((select array_agg(id) from c), '{}'::uuid[]),
           case when (select id from c) is null then ${payload.city_text}::text else null end,
           (select region_slug from c),
           coalesce((select array_remove(array_agg(region_slug), null) from c), '{}'::text[]),
           ${payload.work_type}::work_type,
           ${payload.title}, ${payload.description},
           ${payload.contact_raw}, ${payload.contact_kind}::contact_kind,
           ${s.media_id}::uuid, ${promo},
           'approved'::user_ad_status, now(),
           now() + make_interval(days => ${ttlDays}),
           ${notifyPending}
    returning id`) as unknown as { id: string }[];
  return rows[0]?.id ? String(rows[0]!.id) : null;
}

/**
 * Take down EVERY earlier publication of this schedule (status='archived'), so a repeat replaces
 * its predecessor instead of stacking duplicates in the feed. Runs AFTER the new card exists, so
 * the offer is never absent from the feed for a moment. Idempotent (only 'approved' rows match).
 */
export async function archivePrevious(sql: Sql, scheduleId: string, runNo: number): Promise<number> {
  const rows = (await sql`
    update user_ads set status = 'archived', notify_pending = false
    where status = 'approved'
      and id in (
        select ad_id from scheduled_post_runs
        where schedule_id = ${scheduleId}::uuid and run_no < ${runNo} and ad_id is not null
      )
    returning id`) as unknown as { id: string }[];
  return rows.length;
}

/**
 * Move the schedule forward after a SUCCESSFUL run: count it, clear the failure state, and set the
 * next moment — anchored to start_at + interval × runNo so the cadence does not drift, but re-based
 * on now() when that moment is already behind us (a worker that was down must not fire a burst of
 * catch-up publications). `done_runs < runNo` makes the whole thing idempotent, which is what lets
 * a healed run reuse it. Returns the resulting status.
 */
export async function advanceSchedule(sql: Sql, scheduleId: string, runNo: number): Promise<string | null> {
  const rows = (await sql`
    update scheduled_posts
    set done_runs = ${runNo},
        last_run_at = now(),
        last_error = null,
        fail_count = 0,
        status = case
          when ${runNo} >= total_runs or interval_minutes is null then 'done'
          else status end,
        next_run_at = case
          when ${runNo} >= total_runs or interval_minutes is null then null
          when start_at + make_interval(mins => interval_minutes * ${runNo}) > now()
            then start_at + make_interval(mins => interval_minutes * ${runNo})
          else now() + make_interval(mins => interval_minutes) end
    where id = ${scheduleId}::uuid and done_runs < ${runNo}
    returning status, next_run_at`) as unknown as { status: string; next_run_at: string | null }[];
  return rows[0]?.status ?? null;
}

/**
 * Record a failed publication: the run row stays 'failed' (hence re-claimable) and the schedule
 * gets a retry in RETRY_AFTER_MINUTES — until scheduled_max_fails consecutive failures park it as
 * 'failed' with the reason visible in /posts. Returns the resulting status.
 */
export async function failSchedule(
  sql: Sql,
  scheduleId: string,
  runNo: number,
  message: string,
  maxFails: number,
): Promise<string | null> {
  await sql`
    update scheduled_post_runs set status = 'failed', error = ${message}
    where schedule_id = ${scheduleId}::uuid and run_no = ${runNo}`;
  const rows = (await sql`
    update scheduled_posts
    set fail_count = fail_count + 1,
        last_error = ${message},
        last_run_at = now(),
        status = case when fail_count + 1 >= ${maxFails} then 'failed' else status end,
        next_run_at = case
          when fail_count + 1 >= ${maxFails} then next_run_at
          else now() + make_interval(mins => ${RETRY_AFTER_MINUTES}) end
    where id = ${scheduleId}::uuid
    returning status`) as unknown as { status: string }[];
  return rows[0]?.status ?? null;
}

/** The owner's telegram id (the account that created the schedule), or null. */
async function ownerChat(sql: Sql, createdBy: string | null): Promise<string | null> {
  if (!createdBy) return null;
  try {
    const rows = (await sql`
      select telegram_id::text as tid from users where id = ${createdBy}::uuid limit 1`) as unknown as {
      tid: string | null;
    }[];
    return rows[0]?.tid ?? null;
  } catch {
    return null;
  }
}

/** Tell the owner what happened. Best-effort: a Bot API failure must never fail a publication. */
async function tellOwner(sql: Sql, createdBy: string | null, text: string, deps: ScheduledDeps): Promise<void> {
  try {
    const chat = await ownerChat(sql, createdBy);
    if (!chat) return;
    await deps.send(chat, text);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[scheduled] owner notice failed:', errorText(err));
  }
}

/** The «опубликовал» DM, in the same plain Russian as the preview. */
export function publishedText(
  title: string,
  runNo: number,
  totalRuns: number,
  kind: string,
  nextRunAt: Date | null,
): string {
  const what = kind === 'promo' ? 'Реклама' : 'Объявление';
  const head =
    totalRuns > 1
      ? `${what} опубликовано (${runNo} из ${totalRuns}): «${title.slice(0, 60)}»`
      : `${what} опубликовано: «${title.slice(0, 60)}»`;
  const tail = nextRunAt ? `\nСледующая публикация: ${formatSeoul(nextRunAt)} (Сеул).` : '';
  const note = runNo > 1 ? '\nПрошлая публикация снята — дублей в ленте нет.' : '';
  return `${head}${note}${tail}`;
}

/**
 * Publish everything that is due. Never throws: one broken schedule is recorded and the others
 * still go out. Safe to call from a cron endpoint AND from the tail of another cron — the claim
 * makes a duplicated tick a no-op.
 */
export async function runScheduledPosts(deps: ScheduledDeps = REAL_DEPS): Promise<ScheduledRunResult> {
  const out: ScheduledRunResult = { due: 0, published: 0, failed: 0, finished: 0, skipped: 0 };
  if (!(await getConfigBool('scheduled_enabled', true))) return out;

  const sql = getSql();
  const batch = await getConfigNumber('scheduled_batch', SCHEDULED_BATCH_DEFAULT);
  const maxFails = await getConfigNumber('scheduled_max_fails', SCHEDULED_MAX_FAILS_DEFAULT);
  const ttlDays = await getConfigNumber('user_ad_ttl_days', 14);
  const notifyOwner = await getConfigBool('scheduled_notify_owner', true);

  let due: DueRow[] = [];
  try {
    due = (await sql`
      select id, kind, payload, media_id, created_by, total_runs, done_runs, notify
      from scheduled_posts
      where status = 'active' and next_run_at is not null and next_run_at <= now()
      order by next_run_at asc
      limit ${batch}`) as unknown as DueRow[];
  } catch (err) {
    // The table may not exist yet (deploy-before-migrate). Nothing is due, nothing breaks.
    // eslint-disable-next-line no-console
    console.error('[scheduled] due lookup failed:', errorText(err));
    return out;
  }
  out.due = due.length;

  const started = deps.now();
  for (const s of due) {
    if (deps.now() - started > SCHEDULED_TIME_BUDGET_MS) break; // the rest stays due for the next tick

    const runNo = Number(s.done_runs ?? 0) + 1;
    const scheduleId = String(s.id);

    // ── CLAIM FIRST ────────────────────────────────────────────────────────────────────────────
    let claimed = false;
    try {
      claimed = await claimRun(sql, scheduleId, runNo);
    } catch (err) {
      out.failed += 1;
      // eslint-disable-next-line no-console
      console.error('[scheduled] claim failed:', errorText(err));
      continue;
    }
    if (!claimed) {
      out.skipped += 1;
      // A run we cannot claim is either in flight elsewhere (leave it alone) or ALREADY PUBLISHED
      // while the schedule's bookkeeping was lost — heal that from the journal, never republish.
      try {
        if ((await runStatus(sql, scheduleId, runNo)) === 'done') {
          const status = await advanceSchedule(sql, scheduleId, runNo);
          if (status === 'done') out.finished += 1;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[scheduled] heal failed:', errorText(err));
      }
      continue;
    }

    // ── PUBLISH ────────────────────────────────────────────────────────────────────────────────
    const payload = readPayload(s.payload);
    try {
      const adId = await publishRun(sql, s, payload, ttlDays);
      if (!adId) throw new Error('insert returned no id');

      await sql`
        update scheduled_post_runs set status = 'done', ad_id = ${adId}::uuid, error = null
        where schedule_id = ${scheduleId}::uuid and run_no = ${runNo}`;

      // A repeat REPLACES its predecessor (never re-dates it).
      if (runNo > 1) await archivePrevious(sql, scheduleId, runNo);

      const status = await advanceSchedule(sql, scheduleId, runNo);
      out.published += 1;
      if (status === 'done') out.finished += 1;

      if (notifyOwner) {
        const nextRows = (await sql`
          select next_run_at from scheduled_posts where id = ${scheduleId}::uuid limit 1`) as unknown as {
          next_run_at: string | null;
        }[];
        const next = nextRows[0]?.next_run_at ? new Date(nextRows[0]!.next_run_at!) : null;
        await tellOwner(
          sql,
          s.created_by,
          publishedText(payload.title, runNo, Number(s.total_runs ?? 1), s.kind, next),
          deps,
        );
      }
    } catch (err) {
      out.failed += 1;
      const message = errorText(err);
      // eslint-disable-next-line no-console
      console.error('[scheduled] publish failed:', message);
      let status: string | null = null;
      try {
        status = await failSchedule(sql, scheduleId, runNo, message, maxFails);
      } catch (bookErr) {
        // eslint-disable-next-line no-console
        console.error('[scheduled] failure bookkeeping failed:', errorText(bookErr));
      }
      if (notifyOwner) {
        await tellOwner(
          sql,
          s.created_by,
          status === 'failed'
            ? `Не смог опубликовать «${payload.title.slice(0, 60)}» — больше не пробую. Причина: ${message}`
            : `Не смог опубликовать «${payload.title.slice(0, 60)}», попробую ещё раз через ${RETRY_AFTER_MINUTES} минут.`,
          deps,
        );
      }
    }
  }

  return out;
}
