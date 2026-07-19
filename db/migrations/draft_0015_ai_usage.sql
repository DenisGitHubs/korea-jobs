-- draft_0015_ai_usage.sql
-- korea-jobs — AI token-usage ledger ("весы"). Every SUCCESSFUL model call appends ONE row so
-- the admin /stats can show tokens + an approximate $ cost over 24h / 30d. Two writers:
--   * lib/korea/parser/run.ts     — the batch vacancy parser (caller='parser')
--   * lib/korea/ads/moderation.ts — the user-ad moderator   (caller='ads')
-- The write is BEST-EFFORT (lib/korea/ai-usage.ts swallows + logs on failure), so this table is
-- purely observational: a failed insert never breaks a parse/moderation.
--
-- The *_tokens columns mirror the Anthropic SDK resp.usage fields (verified in the SDK types):
--   input_tokens          <- usage.input_tokens
--   output_tokens         <- usage.output_tokens
--   cache_creation_tokens <- usage.cache_creation_input_tokens  (cache WRITE; 1h ttl ≈ 2x base rate)
--   cache_read_tokens     <- usage.cache_read_input_tokens      (cache HIT;   ≈ 0.1x base rate)
-- caller is free TEXT ('parser' | 'ads') — no enum, so a new writer needs no migration.
-- batch_size = how many messages the call classified (1 for a single ad).
--
-- ADDITIVE ONLY. Guarded (IF NOT EXISTS). DRAFT — DO NOT APPLY; the internal side applies it.
-- Depends on: pgcrypto (gen_random_uuid, draft_0001_init.sql). Apply order: ... 0014 -> 0015.

create table if not exists ai_usage (
  id                    uuid primary key default gen_random_uuid(),
  called_at             timestamptz not null default now(),
  caller                text not null,
  model                 text,
  input_tokens          int,
  output_tokens         int,
  cache_creation_tokens int,
  cache_read_tokens     int,
  batch_size            int
);

comment on table ai_usage is
  'AI token-usage ledger: one row per SUCCESSFUL model call (caller=parser|ads). Best-effort/observational; drives the admin /stats cost view. Additive.';

-- The only access pattern is "sum/count over a recent window" (24h, 30d), so index called_at.
create index if not exists idx_ai_usage_called_at on ai_usage (called_at);
