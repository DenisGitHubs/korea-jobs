// lib/korea/parser/reject-log.ts
//
// Reject journal (owner rule 2026-07-20): so we can look at WHAT the AI throws away, every
// AI-VERDICT reject (not_vacancy / chitchat / resume / agency_promo / … — but NOT 'low_confidence',
// which is the visible "Не проверено" tab, and NOT spam_prefilter, which never reaches the AI) is:
//   (a) counted per day+reason in ai_reject_stats — ALWAYS, tiny. This INCLUDES verdict-cache replays
//       (parser/run.ts step 1c): a reject reused from cache is still a reject that happened, so it advances
//       the counter too (called with logSample:false — counted, but the repeat's full text is not
//       re-stored). Invariant: EVERY AI-verdict reject is counted, whether freshly judged or replayed from
//       cache — the most frequent repeats no longer slip past the counter.
//   (b) sampled in FULL (the whole original text) into ai_reject_samples — ONLY while the owner has
//       flipped reject_log_enabled on, for a day's collection window (cleanup purges >7d).
// Since 2026-10-24 the same two tables also carry, via recordRejectBatch:
//   • `prefilter:<rule>` — which LIVE pre-filter rule dropped a message (spamfilter.ts spamRuleHit);
//     counted always, its full text sampled only while reject_log_enabled is on;
//   • `shadow:<ids>|<outcome>` — a SHADOW rule (spamfilter.ts OBSERVED_RULES) fired on a message that
//     passed the live filter, next to what then happened to it (owner decision 2026-10-24). Counted
//     ALWAYS; a sample is written ALWAYS too, but ONLY for the outcomes vacancy / low_confidence / error
//     and with contacts masked (scrubContacts) — 007, 2026-10-24; parser/run.ts SHADOW_SAMPLED_OUTCOMES.
//     Samples live 10 days (cleanup/run.ts), so every row starting with "shadow:" is third-party text
//     under that clock; db/backup.mjs does not export this table at all.
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

/** One full-text row for ai_reject_samples (the batch form used by the parser's end-of-run flush). */
export interface RejectSample {
  reason: string;
  confidence: number | null;
  postedAt: Date | string | null;
  text: string;
  sourceNote: string | null;
}

/** Postgres `text` refuses U+0000 ("invalid byte sequence"), failing the whole multi-row insert. */
function stripNul(s: string): string {
  return s.includes('\u0000') ? s.replace(/\u0000/g, '') : s;
}

/** ISO string for a timestamptz parameter, or null — an Invalid Date / unparseable string becomes null
 *  instead of throwing here or failing the ::timestamptz[] cast for the whole batch. */
function safePostedAt(v: Date | string | null): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Batch form for the parser's end-of-run flush (parser/run.ts): add every counter in ONE upsert and
 * every sample in ONE insert, instead of a round-trip per message. Used for the live pre-filter
 * counters (`prefilter:<rule>`) and the shadow-rule record (`shadow:<ids>|<outcome>`, owner decision
 * 2026-10-24 — those samples are written regardless of reject_log_enabled, only for the outcomes the
 * caller keeps, contact-masked, and are purged after 10 days, cleanup/run.ts). NUL bytes and invalid
 * dates are neutralised per sample, so one crooked row cannot fail the single insert for all. Same contract as recordAiReject: NEVER throws, and the two writes are
 * independent (a sample fault never costs the counters, and vice versa).
 */
export async function recordRejectBatch(
  counts: ReadonlyMap<string, number>,
  samples: readonly RejectSample[],
): Promise<void> {
  if (counts.size === 0 && samples.length === 0) return;
  let sql: ReturnType<typeof getSql>;
  try {
    sql = getSql();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reject-log] batch skipped (no db):', err instanceof Error ? err.message : String(err));
    return;
  }

  if (counts.size > 0) {
    try {
      // Map keys are unique, so one row per (day, reason) — ON CONFLICT never meets the same key twice.
      const reasons = [...counts.keys()];
      const ns = reasons.map((r) => counts.get(r) ?? 0);
      await sql`
        insert into ai_reject_stats (day, reason, n)
        select current_date, t.reason, t.n
        from unnest(${reasons}::text[], ${ns}::int[]) as t(reason, n)
        on conflict (day, reason) do update set n = ai_reject_stats.n + excluded.n`;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[reject-log] batch stat upsert failed:', err instanceof Error ? err.message : String(err));
    }
  }

  if (samples.length > 0) {
    try {
      // One crooked sample must not cost the whole batch (it is ONE insert): a NUL byte is rejected
      // by Postgres text, and an Invalid Date throws from toISOString — so both are neutralised here.
      const postedAt = samples.map((s) => safePostedAt(s.postedAt));
      await sql`
        insert into ai_reject_samples (reject_reason, confidence, posted_at, text, source_note)
        select * from unnest(
          ${samples.map((s) => stripNul(s.reason))}::text[],
          ${samples.map((s) => s.confidence)}::real[],
          ${postedAt}::timestamptz[],
          ${samples.map((s) => stripNul(s.text))}::text[],
          ${samples.map((s) => (s.sourceNote == null ? null : stripNul(s.sourceNote)))}::text[])`;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[reject-log] batch sample insert failed:', err instanceof Error ? err.message : String(err));
    }
  }
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
