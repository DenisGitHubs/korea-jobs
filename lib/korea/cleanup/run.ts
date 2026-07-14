// lib/korea/cleanup/run.ts
//
// Retention (007 + Законник). Idempotent; safe to run repeatedly:
//   1. deactivate stale vacancies past TTL (frees the dedup slot);
//   2. purge old raw_messages regardless of status — incl. stuck 'pending' — since
//      they hold raw scraped text + phone numbers (third-party PII);
//   3. delete long-inactive vacancies so employers' contacts don't linger forever
//      (cascades clean notifications_sent / contact_reveals).

import { getSql } from '../core/db.js';
import { getConfigNumber } from '../config.js';

export interface CleanupResult {
  deactivated: number;
  purged: number;
  deletedVacancies: number;
}

export async function runCleanup(): Promise<CleanupResult> {
  const sql = getSql();
  const ttlDays = await getConfigNumber('vacancy_ttl_days', 14);
  const rawDays = await getConfigNumber('raw_retention_days', 30);
  const deleteDays = await getConfigNumber('vacancy_delete_days', 30);

  const deact = await sql`
    update vacancies set is_active = false
    where is_active and posted_at < now() - make_interval(days => ${ttlDays})
    returning id`;

  const purged = await sql`
    delete from raw_messages
    where fetched_at < now() - make_interval(days => ${rawDays})
    returning id`;

  const deleted = await sql`
    delete from vacancies
    where not is_active and last_seen_at < now() - make_interval(days => ${deleteDays})
    returning id`;

  return { deactivated: deact.length, purged: purged.length, deletedVacancies: deleted.length };
}
