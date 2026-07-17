-- draft_0005_visa_types.sql
-- korea-jobs — Phase 2 redesign: split the F-series and expose more visa filters.
-- ADDITIVE ONLY. Extends the existing `visa_type` enum with four new labels:
--   f4  — F-4  overseas-Korean ("соотечественник" / этнический кореец)
--   f6  — F-6  marriage to a Korean citizen ("виза по браку")
--   d10 — D-10 job-seeker ("виза для поиска работы")
--   g1  — G-1  humanitarian / asylum ("убежище" / гуманитарный статус)
--
-- Scope after this migration: f_series means F-2 / F-5 ONLY, d_series means D-2 / D-4
-- ONLY (f4 / f6 / d10 are now their own labels). EXISTING vacancy/ad rows are NOT
-- retagged — only newly parsed messages receive the new labels (lib/korea/parser/prompt.ts).
--
-- ⚠ POSTGRES TRANSACTION RULE — read before applying:
--   `ALTER TYPE ... ADD VALUE` may NOT be used in the SAME transaction that later USES
--   the new label, and on PostgreSQL < 12 it cannot run inside a transaction block AT
--   ALL. This file therefore contains ONLY the ADD VALUE statements and NOTHING that
--   uses them. Apply it STANDALONE (autocommit) — do NOT wrap it in an explicit
--   BEGIN/COMMIT together with any statement (or another migration) that reads/writes
--   these labels; the new values must be COMMITTED before first use. The db/apply.mjs
--   runner sends each file as its own query, which satisfies this. On modern Postgres
--   (Neon, PG 15+) the four unused ADD VALUEs run fine in one implicit statement batch.
--   `IF NOT EXISTS` makes every statement idempotent (safe to re-run). New labels are
--   APPENDED to the enum — order is irrelevant, we never ORDER BY visa_type.

alter type visa_type add value if not exists 'f4';
alter type visa_type add value if not exists 'f6';
alter type visa_type add value if not exists 'd10';
alter type visa_type add value if not exists 'g1';
