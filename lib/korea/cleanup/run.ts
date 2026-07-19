// lib/korea/cleanup/run.ts
//
// Retention (007 + Законник). Idempotent; safe to run repeatedly:
//   1. deactivate stale vacancies past TTL (frees the dedup slot);
//   2. enforce takedowns — deactivate any active vacancy whose content_hash is on the
//      takedown list (belt-and-suspenders: the parser pre-check should stop these, but
//      cleanup guarantees a takedown is never left visible);
//   3. expire approved user ads past their expires_at (drops them from the feed);
//   4. JUNK purge (owner rule 2026-07-19): physically delete every raw_message the filter
//      already rejected (status='skipped' with any reject_reason EXCEPT 'low_confidence' —
//      spam_prefilter, crypto/emoji, duplicate, too_old, not_vacancy, chitchat, takedown,
//      admin_hidden, …) IMMEDIATELY. 'low_confidence' is the "Не проверено" tab content and
//      is spared here — it lives until it ages out in step 5;
//   5. 24h purge (owner rule 2026-07-19): physically delete any raw_message older than
//      raw_purge_hours (default 24h, by coalesce(posted_at, fetched_at)) UNLESS it still
//      backs an ACTIVE vacancy card — that raw holds the "открыть в канале" deep link
//      (vacancies/read.ts source_post_url joins rm.tg_message_id), so a live card's raw must
//      survive. Deactivation (step 1) and this purge (step 5) run in the SAME pass, so a card
//      that goes dark this tick usually has its raw removed by this very step the same tick
//      (the backstop, step 6, sweeps any straggler). This also caps the "Не проверено" tab
//      (low_confidence) at ≤24h;
//   6. BACKSTOP purge old raw_messages regardless of status — incl. stuck 'pending' and the
//      raw of long-lived active cards — since they hold raw scraped text + phone numbers
//      (third-party PII). Redundant behind steps 4/5 now, kept as a final safety net;
//   7. delete long-inactive vacancies so employers' contacts don't linger forever
//      (cascades clean notifications_sent / contact_reveals);
//   8. purge old moderation_examples by age — the learning set stores ad text that can
//      contain a phone number, so it must not grow unbounded (007 minor).
//
// NOTE FK: vacancies.raw_message_id -> raw_messages(id) ON DELETE SET NULL (draft_0001_init.sql
// line 322). Deleting a raw row never cascades to a vacancy: the card keeps living, its
// raw_message_id becomes NULL, and source_post_url degrades softly to null (read.ts guards the
// LEFT JOIN miss via `rm.tg_message_id is not null`).

import { getSql } from '../core/db.js';
import { getConfigNumber } from '../config.js';

export interface CleanupResult {
  deactivated: number;
  takedownEnforced: number;
  adsExpired: number;
  junkPurged: number;
  agedRawPurged: number;
  purged: number;
  deletedVacancies: number;
  moderationExamplesPurged: number;
}

export async function runCleanup(): Promise<CleanupResult> {
  const sql = getSql();
  const ttlDays = await getConfigNumber('vacancy_ttl_days', 14);
  const rawPurgeHours = await getConfigNumber('raw_purge_hours', 24);
  const rawDays = await getConfigNumber('raw_retention_days', 30);
  const deleteDays = await getConfigNumber('vacancy_delete_days', 30);
  const modDays = await getConfigNumber('moderation_examples_retention_days', 180);

  const deact = await sql`
    update vacancies set is_active = false
    where is_active and posted_at < now() - make_interval(days => ${ttlDays})
    returning id`;

  const takedown = await sql`
    update vacancies set is_active = false
    where is_active and content_hash in (select content_hash from takedowns)
    returning id`;

  const adsExpired = await sql`
    update user_ads set status = 'expired'
    where status = 'approved' and expires_at is not null and expires_at < now()
    returning id`;

  // JUNK (owner rule 2026-07-19): everything the filter already rejected leaves the DB at once.
  // `is distinct from` is null-safe — a skipped row with a NULL reject_reason (shouldn't happen,
  // but belt-and-suspenders) counts as junk and is removed too. 'low_confidence' ("Не проверено")
  // is the sole exception and is spared here; it ages out via the 24h purge below.
  // SAFETY INVARIANT: vacancies.raw_message_id points ONLY at a status='parsed' row (parser/run.ts
  // sets status='parsed' on the raw it links, right after the vacancy insert) — so this skipped-only
  // purge can NEVER delete the raw backing an active card. Preserve this invariant if the parser is
  // refactored (a card's raw must stay 'parsed', never left 'skipped').
  const junkPurged = await sql`
    delete from raw_messages
    where status = 'skipped' and reject_reason is distinct from 'low_confidence'
    returning id`;

  // 24h (owner rule 2026-07-19): anything older than raw_purge_hours (by posted_at, falling back
  // to fetched_at when Telegram gave no date) is deleted — UNLESS it still backs an ACTIVE card.
  // A live card's raw carries the "открыть в канале" deep link (read.ts source_post_url via
  // rm.tg_message_id); the NOT EXISTS keeps that raw only while the card is active. Since step 1
  // (deactivate stale) already ran THIS tick, a card that just went dark no longer matches the
  // NOT EXISTS and its raw is removed by this same step in the same pass. FK is ON DELETE SET
  // NULL so the card never cascades away.
  const agedRawPurged = await sql`
    delete from raw_messages
    where coalesce(posted_at, fetched_at) < now() - make_interval(hours => ${rawPurgeHours})
      and not exists (
        select 1 from vacancies v
        where v.raw_message_id = raw_messages.id and v.is_active)
    returning id`;

  // BACKSTOP: final safety net (regardless of status / active card). Redundant behind the two
  // purges above now, but kept so nothing can ever linger past the hard retention ceiling.
  const purged = await sql`
    delete from raw_messages
    where fetched_at < now() - make_interval(days => ${rawDays})
    returning id`;

  const deleted = await sql`
    delete from vacancies
    where not is_active and last_seen_at < now() - make_interval(days => ${deleteDays})
    returning id`;

  const modPurged = await sql`
    delete from moderation_examples
    where created_at < now() - make_interval(days => ${modDays})
    returning id`;

  return {
    deactivated: deact.length,
    takedownEnforced: takedown.length,
    adsExpired: adsExpired.length,
    junkPurged: junkPurged.length,
    agedRawPurged: agedRawPurged.length,
    purged: purged.length,
    deletedVacancies: deleted.length,
    moderationExamplesPurged: modPurged.length,
  };
}
