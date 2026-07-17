-- draft_0007_raw_read.sql
-- korea-jobs — Phase 3b redesign: the "UNVERIFIED" stream (GET /api/raw).
--
-- Backs the screen that shows RAW captured messages the parser could NOT confidently
-- turn into a vacancy (original text, marked "не проверено"). No schema change to
-- raw_messages is needed — the columns already exist (draft_0001_init.sql:
-- status/raw_status, vacancy_id, fetched_at, posted_at; draft_0003_moderation.sql:
-- reject_reason). This migration only adds a tunable + a supporting index.
--
-- ADDITIVE ONLY. Guarded (IF NOT EXISTS / ON CONFLICT DO NOTHING). DRAFT — DO NOT APPLY;
-- the internal side applies it. Depends on: raw_messages (draft_0001_init.sql),
-- raw_messages.reject_reason (draft_0003_moderation.sql), config (draft_0001_init.sql).

-- ─────────────────────────────────────────────────────────────────────────────
-- Freshness window for the UNVERIFIED stream: only show raw rows fetched within the
-- last N days (older unsorted noise is dropped). Read via getConfigNumber(
-- 'raw_max_age_days', 14) — tune without a deploy; the API clamps to >= 1.
-- ─────────────────────────────────────────────────────────────────────────────
insert into config (key, value) values ('raw_max_age_days', '14')
on conflict (key) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Supporting index for GET /api/raw. Exactly mirrors the read predicate + order:
--   where vacancy_id is null
--     and (status='pending' or (status='skipped' and reject_reason='low_confidence'))
--     and fetched_at > cutoff
--   order by fetched_at desc, id desc
-- Partial (only the UNVERIFIED bucket) so it stays tiny even as raw_messages grows into
-- the parsed/junk millions. The predicate is IMMUTABLE (constant comparisons only — no
-- now()); the cutoff stays a query-time filter, not part of the index.
-- ─────────────────────────────────────────────────────────────────────────────
create index if not exists idx_raw_unverified
  on raw_messages (fetched_at desc, id desc)
  where vacancy_id is null
    and (status = 'pending' or (status = 'skipped' and reject_reason = 'low_confidence'));
