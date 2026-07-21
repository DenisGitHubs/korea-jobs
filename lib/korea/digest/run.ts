// lib/korea/digest/run.ts
//
// Once-a-day DIGEST DM (owner rule 2026-07-20): each opted-in subscriber gets ONE line —
// "За сутки: N новых вакансий по твоим фильтрам" — summarising how many ACTIVE scraped
// vacancies matching their filters appeared in the last 24h, with an "Открыть" web_app
// button onto /feed. Distinct from the realtime notify push (lib/korea/notify/run.ts): the
// digest is a low-frequency morning summary, not a per-item alert.
//
// SELF-THROTTLED — the endpoint is polled every ~3 min by the existing external scheduler and
// decides for itself whether it is time. Two guards:
//   1. GLOBAL window + rate: only 09:00–12:00 Asia/Seoul, and at most once / 22h. The 22h gate
//      is an ATOMIC claim on config 'digest_last_run' (the referral-confirm single-flight
//      pattern): the run writes the marker IFF the stored epoch is older than the gap, so an
//      overlapping/duplicate tick is a no-op. Claiming up front means a mid-run failure just
//      skips the rest of today's batch (next claim is 22h out) rather than double-DMing anyone.
//   2. PER-USER dedup — subscriptions.last_digest_at is stamped on a delivered digest; the run
//      only picks users whose last digest is NULL or older than 22h.
//
// Matching reuses the SAME permissive predicates as notify/vacSubs (Sanya/Roma K2): a filter
// excludes only rows that EXPLICITLY contradict it; "not stated"/empty always passes. The per-user
// count is a single correlated query (no N+1 fan-out), so the predicate list is duplicated here by
// necessity (the notify version matches ONE vacancy against MANY subs; this matches ONE sub against
// MANY vacancies — same semantics, inverted direction). Keep the two lists in lockstep.
//
// MULTI-CITY: the CITY predicate here is the SHARED kj_city_match(s.city_ids, v.city_ids, s.no_city)
// (draft_0020) — the EXACT same rule the feed applies (vacancies/read.ts), so the digest count can
// never drift from what the feed shows. This is why the digest is the no_city-aware surface while
// notify (realtime) is deliberately narrower and ignores no_city (see notify/run.ts). `no_city=false`
// is itself a filter, so it also flips has_filters -> "по твоим фильтрам" wording.
//
// Caps/pacing mirror notify: at most digest_send_cap DMs per run, 40ms between sends. A 403 flips
// users.is_blocked; a 429 sleeps and stops the run (the rest roll into tomorrow's digest); a
// transient error skips that user for this run (no stamp -> retried next day).

import { getSql } from '../core/db.js';
import { getConfigBool, getConfigNumber } from '../config.js';
import { sendMessage, isUserUnavailable, retryAfterSeconds } from '../bot/telegram.js';

export interface DigestResult {
  ran: boolean; // true only when the window+claim gate passed and recipients were processed
  skipped: 'disabled' | 'window' | 'throttled' | null; // why the run did nothing (null when it ran)
  recipients: number; // users with N>0 selected this run
  sent: number; // digest DMs actually delivered
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const DIGEST_WINDOW_START_HOUR = 9; // inclusive
export const DIGEST_WINDOW_END_HOUR = 12; // exclusive
export const DIGEST_MIN_GAP_HOURS = 22;

/**
 * Current hour (0–23) in Asia/Seoul. Primary path is Intl with the tz database; if that is
 * unavailable (stripped ICU data) it falls back to a fixed UTC+9 (Seoul has no DST, so the offset
 * is constant year-round). Both paths normalise a possible '24' (some engines emit it for midnight).
 */
export function seoulHour(now: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(now);
    const raw = parts.find((p) => p.type === 'hour')?.value;
    const h = Number(raw);
    if (Number.isFinite(h)) return (((h % 24) + 24) % 24);
  } catch {
    /* Intl/tz data missing -> fixed-offset fallback below */
  }
  return (((now.getUTCHours() + 9) % 24) + 24) % 24;
}

/** True inside the morning send window [09:00, 12:00) Asia/Seoul. */
export function inDigestWindow(hour: number): boolean {
  return hour >= DIGEST_WINDOW_START_HOUR && hour < DIGEST_WINDOW_END_HOUR;
}

/** Russian noun agreement for "N вакансий". Keeps the digest line grammatical (owner: plain human text). */
export function ruPluralVac(n: number): string {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs >= 11 && abs <= 14) return 'новых вакансий';
  if (d === 1) return 'новая вакансия';
  if (d >= 2 && d <= 4) return 'новые вакансии';
  return 'новых вакансий';
}

/** The single digest line. `hasFilters` switches "по твоим фильтрам" vs the empty-filter "в приложении". */
export function digestText(n: number, hasFilters: boolean): string {
  const noun = ruPluralVac(n);
  return hasFilters
    ? `За сутки: ${n} ${noun} по твоим фильтрам` // plain text — no parse_mode
    : `За сутки: ${n} ${noun} в приложении`;
}

/** web_app "Открыть" button onto /feed, or {} when APP_URL is unset (degrades to text-only). */
function openButton(appUrl: string | undefined): Record<string, unknown> {
  return appUrl
    ? {
        reply_markup: {
          inline_keyboard: [[{ text: 'Открыть', web_app: { url: `${appUrl.replace(/\/+$/, '')}/feed` } }]],
        },
      }
    : {};
}

interface Recipient {
  user_id: string;
  telegram_id: string;
  has_filters: boolean;
  n: number;
}

export async function runDigest(now: Date = new Date()): Promise<DigestResult> {
  // Global kill-switch (config key, fallback true -> no seed needed): lets the owner disable ALL
  // digests without a migration, mirroring notify's 'notify_enabled'. Named distinctly from the
  // per-user subscriptions.digest_enabled COLUMN to avoid confusing the two.
  if (!(await getConfigBool('digest_notify_enabled', true)))
    return { ran: false, skipped: 'disabled', recipients: 0, sent: 0 };

  if (!inDigestWindow(seoulHour(now)))
    return { ran: false, skipped: 'window', recipients: 0, sent: 0 };

  const sql = getSql();
  const minGapSeconds = DIGEST_MIN_GAP_HOURS * 3600;

  // ── Atomic once-per-22h claim + single-flight (referral-confirm pattern). Empty result => a run
  //    already fired inside the window -> skip. 'digest_last_run' is an epoch-seconds jsonb number. ──
  const claim = (await sql`
    insert into config (key, value)
    values ('digest_last_run', to_jsonb(extract(epoch from now())))
    on conflict (key) do update set value = to_jsonb(extract(epoch from now())), updated_at = now()
      where coalesce((config.value #>> '{}')::double precision, 0) < extract(epoch from now()) - ${minGapSeconds}
    returning true as claimed`) as unknown as { claimed: boolean }[];
  if (claim.length === 0) return { ran: false, skipped: 'throttled', recipients: 0, sent: 0 };

  const sendCap = await getConfigNumber('digest_send_cap', 500);
  const appUrl = process.env.APP_URL;

  // ── Eligible subscribers + their 24h match count in ONE query. `has_filters` picks the empty-
  //    filter wording. n is a correlated count of ACTIVE scraped vacancies (first_seen_at in 24h)
  //    matched by the SAME permissive predicates as notify/vacSubs. Only n>0 users are returned. ──
  const rows = (await sql`
    select q.user_id, q.telegram_id, q.has_filters, q.n from (
      select u.id as user_id, u.telegram_id,
        (
          cardinality(s.city_ids) > 0
          or (s.work_types is not null and cardinality(s.work_types) > 0)
          or cardinality(s.visa_types) > 0
          or s.placement_fee is not null
          or s.require_housing is true
          or s.require_meals is true
          or s.no_city is false
        ) as has_filters,
        (
          select count(*) from vacancies v
          where v.is_active and v.duplicate_of is null
            and v.first_seen_at > now() - interval '24 hours'
            and kj_city_match(s.city_ids, v.city_ids, s.no_city)
            and (s.work_types is null or cardinality(s.work_types) = 0 or v.work_type = any(s.work_types))
            and (
              cardinality(s.visa_types) = 0
              or v.visa_types is null or cardinality(v.visa_types) = 0
              or 'any'::visa_type = any(v.visa_types)
              or s.visa_types && v.visa_types
            )
            and (s.placement_fee is null or v.placement_fee = s.placement_fee or v.placement_fee = 'unknown')
            and (s.require_housing is not true or v.has_housing is true or v.has_housing is null)
            and (s.require_meals   is not true or v.has_meals   is true or v.has_meals   is null)
        )::int as n
      from subscriptions s
      join users u on u.id = s.user_id
      -- digest_enabled is INDEPENDENT of the realtime notify toggle (Censor, gate 21.07):
      -- a user may want ONLY the once-a-day digest with realtime pushes off. The bot's
      -- permission to DM is allows_write_to_pm/is_blocked, not subscriptions.notify.
      where s.digest_enabled
        and u.allows_write_to_pm and not u.is_blocked
        and (s.last_digest_at is null or s.last_digest_at < now() - interval '22 hours')
    ) q
    where q.n > 0
    order by q.user_id
    limit ${sendCap}`) as unknown as Recipient[];

  // ── One DM per user, stamping last_digest_at on success. Caps/retry mirror notify. ──
  let sent = 0;
  for (const r of rows) {
    const text = digestText(r.n, r.has_filters === true);
    const resp = await sendMessage(String(r.telegram_id), text, openButton(appUrl));
    if (resp.ok) {
      sent += 1;
      await sql`update subscriptions set last_digest_at = now() where user_id = ${r.user_id}::uuid`;
    } else if (isUserUnavailable(resp)) {
      // 403: blocked / never started -> stop DMing this user (also drops them from every push).
      await sql`update users set is_blocked = true where id = ${r.user_id}::uuid`;
    } else {
      const ra = retryAfterSeconds(resp);
      if (ra !== null) {
        await sleep((ra + 1) * 1000); // 429: back off and stop; the rest roll into tomorrow's digest
        break;
      }
      // transient: skip this user for this run (no stamp) -> retried in the next day's digest
      // eslint-disable-next-line no-console
      console.error('[digest] send failed (skipped this run)');
    }
    await sleep(40); // ~25 msg/s, under the global 30/s Bot API ceiling
  }

  return { ran: true, skipped: null, recipients: rows.length, sent };
}
