// lib/korea/parser/reject-log.ts
//
// Reject journal (owner rule 2026-07-20): so we can look at WHAT the AI throws away, every
// AI-VERDICT reject (not_vacancy / chitchat / resume / agency_promo / … — but NOT 'low_confidence',
// which is the visible "Не проверено" tab, and NOT spam_prefilter, which never reaches the AI) is:
//   (a) counted per day+reason in ai_reject_stats — always, tiny;
//   (b) sampled in FULL (the whole original text) into ai_reject_samples — ONLY while the owner has
//       flipped reject_log_enabled on, for a day's collection window (cleanup purges >7d).
//
// BEST-EFFORT by design (mirrors ai-usage.ts): a write fault here MUST NEVER break a parse. Each
// write is independently try/wrapped so a missing sample table can't stop the stats counter and
// vice-versa. Both tables are INTERNAL — no API/bot surface reads them (owner inspects directly).
//
// See db/migrations/draft_0016_reject_log.sql.

import { getSql } from '../core/db.js';

export interface RejectLogArgs {
  /** The stored reject_reason (already resolved by the caller; never 'low_confidence' here). */
  reason: string;
  /** Model confidence 0..1, or null when the model omitted it. */
  confidence: number | null;
  /** The raw posting date (raw_messages.posted_at), or null. */
  postedAt: Date | string | null;
  /** The FULL original message text (owner wants to inspect the real thing). */
  text: string;
  /** Cheap source label (the source channel username from the existing join), or null. */
  sourceNote: string | null;
  /** Whether to also persist the full text sample (getConfigBool('reject_log_enabled')). */
  logSample: boolean;
}

/**
 * Count the reject (always) and, when logSample, keep its full text. NEVER throws. Callers can
 * `await` this on the reject path without any risk to the batch.
 */
export async function recordAiReject(args: RejectLogArgs): Promise<void> {
  const sql = getSql();

  // (a) day+reason counter — additive upsert, crashproof.
  try {
    await sql`
      insert into ai_reject_stats (day, reason, n)
      values (current_date, ${args.reason}, 1)
      on conflict (day, reason) do update set n = ai_reject_stats.n + 1`;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reject-log] stat upsert failed:', err instanceof Error ? err.message : String(err));
  }

  // (b) full-text sample — only when the flag is on. Separate try so a sample fault never affects (a).
  if (!args.logSample) return;
  try {
    await sql`
      insert into ai_reject_samples (reject_reason, confidence, posted_at, text, source_note)
      values (
        ${args.reason}, ${args.confidence}, ${args.postedAt ?? null}::timestamptz,
        ${args.text}, ${args.sourceNote}
      )`;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reject-log] sample insert failed:', err instanceof Error ? err.message : String(err));
  }
}
