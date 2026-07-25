-- draft_0025_hide_unverified.sql
-- korea-jobs — owner kill-switch for the «Не проверено» (UNVERIFIED) stream. ADDITIVE / IDEMPOTENT.
--
-- Seeds ONE config row: hide_unverified = false. FALSE means "nothing changes" — the stream behaves
-- exactly as today. The owner flips it to true (or back) in the DB, with NO deploy, once the numbers
-- are in. Effect while true:
--   * GET  /api/raw          -> 200 { items: [], next_cursor: null }  (lib/korea/raw/read.ts)
--   * POST /api/raw/reveal   -> 404 not_found                          (lib/korea/raw/reveal.ts)
--   * GET  /api/me           -> flags.hide_unverified = true, so the app can hide the tab entirely
-- Enforcement is server-side; the client flag is only cosmetic. Takes effect within ~60s of the flip
-- (lib/korea/config.ts caches the config table for 60s per warm serverless instance).
--
-- This file is NOT required for the code to work: getConfigBool('hide_unverified', false) already
-- falls back to false when the key is missing. The row exists so the switch is DISCOVERABLE in the
-- config table instead of being invisible tribal knowledge.
--
-- ON CONFLICT DO NOTHING (never DO UPDATE) — same rule as draft_seed.sql: a re-apply of the migration
-- list must never silently revert an owner-tuned value back to false.
--
-- Depends on: config (draft_0001_init.sql).
--
-- DRAFT — DO NOT APPLY; the internal side applies it (db/apply.mjs, appended to the end of the list).

insert into config (key, value) values
  ('hide_unverified', 'false')   -- true = hide the «Не проверено» stream from the app entirely
on conflict (key) do nothing;

-- HOW TO FLIP (owner, no deploy — run ONE of these):
--   turn ON  : update config set value = 'true'::jsonb  where key = 'hide_unverified';
--   turn OFF : update config set value = 'false'::jsonb where key = 'hide_unverified';
-- VERIFY   : select key, value from config where key = 'hide_unverified';
-- NOTE: the value must be a JSON boolean (true/false), NOT the string "true" — getConfigBool only
-- accepts a real boolean and falls back to false for anything else (a quoted "true" = switch OFF).
