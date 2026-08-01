// lib/korea/scheduled/store.ts
//
// Every database touch of the «отложенные публикации» tool that is NOT the publishing worker
// (that one lives in run.ts). Kept together so the webhook holds no scheduling SQL, exactly like
// broadcast/run.ts does for /broadcast.
//
// STATE MACHINE (draft_0030): draft → active → done, with cancelled/failed as the two exits.
//   * [Запланировать] claims ATOMICALLY (update … where status='draft'), so a second tap or a
//     replayed callback matches 0 rows and can never schedule the same post twice;
//   * [Отмена] / «Отменить» in /posts flips draft|active → cancelled, and the worker only ever
//     looks at status='active' — so cancelling is instant and needs no coordination with it.

import { getSql } from '../core/db.js';
import { buildCityMatcher, detectCitySlugs } from '../cities/detect.js';
import type { PostKind, PostPayload } from './parse.js';

type Sql = ReturnType<typeof getSql>;

/** The payload as stored in scheduled_posts.payload (snake_case = the DB column names it feeds). */
export interface StoredPayload {
  title: string;
  description: string;
  contact_raw: string | null;
  contact_kind: string | null;
  work_type: string;
  city_slug: string | null;
  city_text: string | null;
}

/** Where the owner's «город: …» landed: a directory city, free text, or nothing at all. */
export interface ResolvedCity {
  citySlug: string | null;
  cityText: string | null;
  /** What to print in the preview. */
  label: string | null;
}

/**
 * Resolve the owner's «город» against the cities directory, reusing the SAME alias matcher the
 * parser and the user-ad path use — so «Ансан», «ansan» and «안산» all land on one slug and the
 * card is reachable by the city filter. An unknown word is kept as free text (city_text), exactly
 * like the "Другое" city in the mini app form.
 */
export async function resolveCity(sql: Sql, input: string | null): Promise<ResolvedCity> {
  if (!input) return { citySlug: null, cityText: null, label: null };
  try {
    const rows = (await sql`
      select slug, name, aliases from cities where is_active = true`) as unknown as {
      slug: string;
      name: unknown;
      aliases: unknown;
    }[];
    const matcher = buildCityMatcher(rows.map((r) => ({ slug: r.slug, aliases: r.aliases })));
    const slug = detectCitySlugs(input, matcher)[0] ?? null;
    if (slug) {
      const row = rows.find((r) => r.slug === slug);
      const name = row?.name as { ru?: string } | undefined;
      return { citySlug: slug, cityText: null, label: name?.ru ?? slug };
    }
  } catch {
    // Directory unavailable → keep what the owner typed. A missing city only narrows reach; it is
    // never a reason to refuse the whole schedule.
    // eslint-disable-next-line no-console
    console.error('[scheduled] city lookup failed');
  }
  return { citySlug: null, cityText: input, label: input };
}

/**
 * The owner's users row id, upserted from his telegram_id — the SAME upsert /start performs, so
 * this can never create a second account. The published ad needs a real author: the notify worker
 * excludes the author from the push (nobody should be notified about his own post) and «Мои
 * объявления» must show it.
 */
export async function resolveAuthorId(sql: Sql, telegramId: number | string): Promise<string | null> {
  try {
    const rows = (await sql`
      insert into users (telegram_id, allows_write_to_pm)
      values (${String(telegramId)}::bigint, true)
      on conflict (telegram_id) do update set last_seen_at = now()
      returning id`) as unknown as { id: string }[];
    return rows[0]?.id ? String(rows[0]!.id) : null;
  } catch {
    // eslint-disable-next-line no-console
    console.error('[scheduled] author lookup failed');
    return null;
  }
}

export interface DraftInput {
  createdBy: string | null;
  kind: PostKind;
  payload: PostPayload;
  city: ResolvedCity;
  mediaId: string | null;
  startAt: Date;
  intervalMinutes: number | null;
  totalRuns: number;
  notify: boolean;
}

/** Turn the parsed payload + resolved city into the jsonb we store. */
export function toStoredPayload(payload: PostPayload, city: ResolvedCity): StoredPayload {
  return {
    title: payload.title,
    description: payload.description,
    contact_raw: payload.contactRaw,
    contact_kind: payload.contactKind,
    work_type: payload.workType,
    city_slug: city.citySlug,
    city_text: city.cityText,
  };
}

/**
 * Insert a DRAFT schedule and return its id. next_run_at is set together with start_at so the
 * worker needs no special case for the first run. Nothing is published until the owner confirms
 * (status stays 'draft', and the worker only reads 'active').
 *
 * PROMO CAN NEVER BE NOTIFIED — the flag is forced false here as well as in the parser and in the
 * publisher: a paid placement that reached somebody's DM is exactly the failure this rule exists
 * to prevent, so it is closed at every layer that could write it.
 */
export async function insertScheduleDraft(sql: Sql, input: DraftInput): Promise<string> {
  const payload = toStoredPayload(input.payload, input.city);
  const notify = input.kind === 'promo' ? false : input.notify;
  const rows = (await sql`
    insert into scheduled_posts (
      created_by, kind, payload, media_id, start_at, interval_minutes, total_runs, next_run_at, notify, status
    ) values (
      ${input.createdBy}::uuid, ${input.kind}, ${JSON.stringify(payload)}::jsonb, ${input.mediaId}::uuid,
      ${input.startAt.toISOString()}::timestamptz, ${input.intervalMinutes}, ${input.totalRuns},
      ${input.startAt.toISOString()}::timestamptz, ${notify}, 'draft'
    )
    returning id`) as unknown as { id: string }[];
  return String(rows[0]!.id);
}

export interface ActivatedSchedule {
  kind: string;
  startAt: Date;
  intervalMinutes: number | null;
  totalRuns: number;
  notify: boolean;
}

/**
 * ATOMICALLY confirm a draft: draft → active. Returns the schedule (so the confirmation message
 * can repeat it in words), or null when the row is not a draft any more — a re-tap, a replayed
 * callback, or a cancel that got there first. The claim is the anti-double-schedule guard.
 */
export async function activateSchedule(sql: Sql, id: string): Promise<ActivatedSchedule | null> {
  const rows = (await sql`
    update scheduled_posts set status = 'active'
    where id = ${id}::uuid and status = 'draft'
    returning kind, start_at, interval_minutes, total_runs, notify`) as unknown as {
    kind: string;
    start_at: string;
    interval_minutes: number | null;
    total_runs: number;
    notify: boolean;
  }[];
  const r = rows[0];
  if (!r) return null;
  return {
    kind: r.kind,
    startAt: new Date(r.start_at),
    intervalMinutes: r.interval_minutes ?? null,
    totalRuns: r.total_runs,
    notify: r.notify === true,
  };
}

/** Cancel a schedule while it is still draft or active. True when this call is the one that did it. */
export async function cancelSchedule(sql: Sql, id: string): Promise<boolean> {
  const rows = (await sql`
    update scheduled_posts set status = 'cancelled'
    where id = ${id}::uuid and status in ('draft', 'active')
    returning id`) as unknown as { id: string }[];
  return rows.length > 0;
}

export interface ScheduleListItem {
  id: string;
  kind: string;
  status: string;
  title: string | null;
  nextRunAt: Date | null;
  doneRuns: number;
  totalRuns: number;
  lastError: string | null;
}

/**
 * The owner's schedules for /posts: active ones by default (that is what he can still change),
 * everything except drafts when `all` is set. Newest activity first, capped — this is a chat
 * listing, not a report.
 */
export async function listSchedules(sql: Sql, all: boolean, limit = 10): Promise<ScheduleListItem[]> {
  const rows = (await sql`
    select id, kind, status, payload ->> 'title' as title, next_run_at, done_runs, total_runs, last_error
    from scheduled_posts
    where status = 'active' or (${all} and status <> 'draft')
    order by (status = 'active') desc, coalesce(next_run_at, created_at) asc
    limit ${limit}`) as unknown as {
    id: string;
    kind: string;
    status: string;
    title: string | null;
    next_run_at: string | null;
    done_runs: number;
    total_runs: number;
    last_error: string | null;
  }[];
  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind,
    status: r.status,
    title: r.title ?? null,
    nextRunAt: r.next_run_at ? new Date(r.next_run_at) : null,
    doneRuns: Number(r.done_runs ?? 0),
    totalRuns: Number(r.total_runs ?? 1),
    lastError: r.last_error ?? null,
  }));
}
