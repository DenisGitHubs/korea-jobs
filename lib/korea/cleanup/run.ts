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
//      backs an ACTIVE vacancy card. NOTE (draft_0023, 2026-07-22): the "открыть в канале" deep link
//      (vacancies.source_post_url) is now PERSISTED on the vacancy at parse time, so it NO LONGER
//      depends on the raw surviving — the NOT EXISTS guard below is kept only as belt-and-suspenders
//      (harmless; the raw of an active card carries no user-facing data now). Deactivation (step 1) and
//      this purge (step 5) run in the SAME pass, so a card that goes dark this tick usually has its raw
//      removed by this very step the same tick (the backstop, step 6, sweeps any straggler). This also
//      caps the "Не проверено" tab (low_confidence) at ≤24h;
//   6. BACKSTOP purge old raw_messages regardless of status — incl. stuck 'pending' and the
//      raw of long-lived active cards — since they hold raw scraped text + phone numbers
//      (third-party PII). Redundant behind steps 4/5 now, kept as a final safety net;
//   7. delete long-inactive vacancies so employers' contacts don't linger forever
//      (cascades clean notifications_sent / contact_reveals);
//   8. purge old moderation_examples by age — the learning set stores ad text that can
//      contain a phone number, so it must not grow unbounded (007 minor);
//   9. purge ai_reject_samples older than 7 days (owner rule 2026-07-20) — the reject-inspection
//      buffer holds full raw text (third-party PII), so it is time-boxed; the tiny per-day
//      ai_reject_stats counters are kept (not purged);
//  10. purge ai_verdict_cache older than 7 days by last_seen (owner rule 2026-07-21) — the reject-verdict
//      reuse cache (parser/verdict-cache.ts) is a rolling, self-refreshing memory: a hash not seen again
//      within 7 days ages out. Best-effort (deploy-before-migrate window may lack the table).
//
// NOTE FK: vacancies.raw_message_id -> raw_messages(id) ON DELETE SET NULL (draft_0001_init.sql
// line 322). Deleting a raw row never cascades to a vacancy: the card keeps living and its
// raw_message_id becomes NULL. Its source_post_url is UNAFFECTED — since draft_0023 that link is a
// PERSISTED column on the vacancy (filled by the parser), independent of the raw's lifetime. NO cleanup
// statement here reads or writes vacancies.source_post_url, so a raw purge can never blank the link.

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
  rejectSamplesPurged: number;
  verdictCachePurged: number;
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
  // The NOT EXISTS keeps a card's raw only while the card is active. (Since draft_0023 the
  // "открыть в канале" link is persisted on the vacancy, so this guard is no longer needed for the
  // link — kept as harmless belt-and-suspenders; source_post_url is a vacancy column, never touched
  // here.) Since step 1 (deactivate stale) already ran THIS tick, a card that just went dark no longer
  // matches the NOT EXISTS and its raw is removed by this same step. FK is ON DELETE SET NULL so the
  // card never cascades away.
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

  // AI reject SAMPLES (owner rule 2026-07-20): the full-text inspection buffer is time-boxed. Keep a
  // day's collection window plus slack — purge samples older than 7 days. The tiny ai_reject_stats
  // COUNTERS are deliberately NOT purged (they are cheap and the whole point is a running tally).
  // Best-effort like ai-usage/stats reads (Цензор, gate 20.07): in the deploy-before-migrate window
  // the table may not exist yet — swallow, so the other cleanup steps' results still return 200.
  let rejectSamplesPurged: unknown[] = [];
  try {
    rejectSamplesPurged = await sql`
      delete from ai_reject_samples
      where rejected_at < now() - interval '7 days'
      returning id`;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[cleanup] ai_reject_samples purge failed (table missing?):', err instanceof Error ? err.message : String(err));
  }

  // AI verdict cache (owner rule 2026-07-21): the reject-verdict reuse cache (parser/verdict-cache.ts) is
  // a rolling memory keyed by last_seen — every hit refreshes it, so a hash not seen for 7 days ages out.
  // Best-effort like the reject-samples purge above: in the deploy-before-migrate window the table may not
  // exist yet — swallow so the other cleanup steps still return their counts.
  let verdictCachePurged: unknown[] = [];
  try {
    verdictCachePurged = await sql`
      delete from ai_verdict_cache
      where last_seen < now() - interval '7 days'
      returning text_hash`;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[cleanup] ai_verdict_cache purge failed (table missing?):', err instanceof Error ? err.message : String(err));
  }

  return {
    deactivated: deact.length,
    takedownEnforced: takedown.length,
    adsExpired: adsExpired.length,
    junkPurged: junkPurged.length,
    agedRawPurged: agedRawPurged.length,
    purged: purged.length,
    deletedVacancies: deleted.length,
    moderationExamplesPurged: modPurged.length,
    rejectSamplesPurged: rejectSamplesPurged.length,
    verdictCachePurged: verdictCachePurged.length,
  };
}
