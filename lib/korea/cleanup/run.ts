// lib/korea/cleanup/run.ts
//
// Retention (007 + Законник). Idempotent; safe to run repeatedly:
//   1. deactivate stale vacancies past TTL (frees the dedup slot);
//   2. enforce takedowns — deactivate any active vacancy whose content_hash is on the
//      takedown list (belt-and-suspenders: the parser pre-check should stop these, but
//      cleanup guarantees a takedown is never left visible);
//   3. expire approved user ads past their expires_at (drops them from the feed);
//   4. purge old raw_messages regardless of status — incl. stuck 'pending' — since
//      they hold raw scraped text + phone numbers (third-party PII);
//   5. delete long-inactive vacancies so employers' contacts don't linger forever
//      (cascades clean notifications_sent / contact_reveals);
//   6. purge old moderation_examples by age — the learning set stores ad text that can
//      contain a phone number, so it must not grow unbounded (007 minor).

import { getSql } from '../core/db.js';
import { getConfigNumber } from '../config.js';

export interface CleanupResult {
  deactivated: number;
  takedownEnforced: number;
  adsExpired: number;
  purged: number;
  deletedVacancies: number;
  moderationExamplesPurged: number;
}

export async function runCleanup(): Promise<CleanupResult> {
  const sql = getSql();
  const ttlDays = await getConfigNumber('vacancy_ttl_days', 14);
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
    purged: purged.length,
    deletedVacancies: deleted.length,
    moderationExamplesPurged: modPurged.length,
  };
}
