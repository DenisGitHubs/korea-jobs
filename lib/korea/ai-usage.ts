// lib/korea/ai-usage.ts
//
// AI token-usage ledger writer ("весы"). Every SUCCESSFUL model call — the batch vacancy parser
// (lib/korea/parser/run.ts) and the ad moderator (lib/korea/ads/moderation.ts) — appends ONE
// ai_usage row from resp.usage so admin /stats can show tokens + an approximate $ cost.
//
// BEST-EFFORT by design: a write fault here MUST NOT break a parse/moderation — we swallow and
// log the message only (never the payload). Shared so both callers write the SAME shape and can
// never drift. See db/migrations/draft_0015_ai_usage.sql.

import { getSql } from './core/db.js';

/** The subset of the SDK's resp.usage we persist (extra fields ignored; nullable per the SDK). */
export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Append one usage row. NEVER throws — on any fault (incl. the table not existing yet on a
 * deploy-before-migrate window) it logs the message and returns, so callers can `await` it on
 * their success path without risking the batch.
 */
export async function recordAiUsage(
  caller: 'parser' | 'ads',
  model: string,
  usage: UsageLike | null | undefined,
  batchSize: number,
): Promise<void> {
  try {
    if (!usage) return;
    const sql = getSql();
    await sql`
      insert into ai_usage (
        caller, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, batch_size
      ) values (
        ${caller}, ${model},
        ${usage.input_tokens ?? null}, ${usage.output_tokens ?? null},
        ${usage.cache_creation_input_tokens ?? null}, ${usage.cache_read_input_tokens ?? null},
        ${batchSize}
      )`;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[ai-usage] record failed:', err instanceof Error ? err.message : String(err));
  }
}
