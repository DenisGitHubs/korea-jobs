-- draft_0023_source_post_url.sql
-- korea-jobs — PERSIST the original-post deep link on the vacancy itself (owner rule 2026-07-22).
--
-- Problem: source_post_url (the "открыть в канале" fallback, https://t.me/<sources.username>/<tg_message_id>)
-- was computed ON READ by joining vacancies -> raw_messages -> sources in vacancies/read.ts. But the 24h
-- raw purge (lib/korea/cleanup/run.ts) deletes raw_messages ~a day after capture and the FK
-- vacancies.raw_message_id -> raw_messages(id) is ON DELETE SET NULL, so rm.tg_message_id vanishes and the
-- join yields NULL — the link is LOST. Result (live DB 22.07): of 185 active contactless offers, 116 became
-- "dead ends" (no contact AND no recoverable link) — invisible-worthy but still shown.
--
-- Fix: store the link ON the vacancy at parse time (lib/korea/parser/run.ts), independent of the raw's
-- lifetime. This column is the SINGLE source read.ts now projects from (the join-CASE is retired). Unreachable
-- offers (contact_normalized IS NULL AND source_post_url IS NULL) are then hidden from the feed + /count.
--
--   * vacancies.source_post_url (text, NULLABLE) — the public original-post link, or NULL when the source
--     channel has no username / the tg_message_id is unknown. The parser fills it on INSERT (coalesce-kept
--     on conflict, never overwritten with NULL); db/backfill_source_link.mts fills existing rows whose raw
--     still survives. NULL is a valid, expected value (private channel, or raw already purged pre-backfill).
--
-- contact_raw / contact_normalized / content_hash / city_id / city_ids are NOT touched by this migration.
--
-- ADDITIVE ONLY. Guarded (IF NOT EXISTS) -> idempotent on every apply.mjs re-run.
-- DRAFT — DO NOT APPLY; the internal side applies it. Apply order: ... 0022 -> 0023.
-- Depends on: vacancies (draft_0001_init.sql).

alter table vacancies add column if not exists source_post_url text;

comment on column vacancies.source_post_url is
  'Public original-post deep link https://t.me/<source username>/<tg_message_id>, PERSISTED at parse time so it survives the 24h raw_messages purge. NULL when the channel has no username / message id unknown. Read.ts projects it (contact-less OR city-less rule) and hides offers with neither a contact nor this link.';
