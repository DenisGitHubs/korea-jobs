-- draft_0024_notify_default_off.sql
-- korea-jobs — MAILING IS OPT-IN (owner rule 2026-07-25). ADDITIVE / IDEMPOTENT / NON-DESTRUCTIVE.
--
-- Nothing may look "already on" that the user did not explicitly switch on. Until now three layers
-- said the opposite:
--   1. the client pre-checked the onboarding toggle              -> fixed in the mini app;
--   2. POST /api/subscription read an ABSENT flag as TRUE        -> fixed in lib/korea/subscriptions/rw.ts;
--   3. the COLUMN DEFAULTS were `true`                            -> fixed HERE.
-- Layer 3 matters because a row can be inserted without naming these columns (a future INSERT, a
-- manual fix, a backfill); with a `true` default such a row would silently opt the user into mail.
--
-- WHAT THIS FILE DOES / DOES NOT DO
--   * DOES: flip the DEFAULT of subscriptions.notify and subscriptions.digest_enabled to false.
--   * DOES NOT: touch a single EXISTING row. No UPDATE, no data change. People who already made a
--     choice keep it — that choice is theirs, not ours (explicit owner instruction). A DEFAULT only
--     applies to rows inserted WITHOUT the column, so existing subscriptions are unaffected.
--   * DOES NOT: change NOT NULL, indexes, or any read path. idx_subscriptions_notify (partial, where
--     notify) and idx_subscriptions_digest (partial, where notify and digest_enabled) stay valid as-is.
--
-- Re-applying is a no-op (SET DEFAULT is absolute, not incremental).
--
-- Depends on: subscriptions.notify (draft_0001_init.sql), subscriptions.digest_enabled
-- (draft_0017_digest.sql).
--
-- DRAFT — DO NOT APPLY; the internal side applies it (db/apply.mjs, appended to the end of the list).

begin;

alter table subscriptions alter column notify         set default false;
alter table subscriptions alter column digest_enabled set default false;

comment on column subscriptions.notify is
  'Realtime push opt-in. OPT-IN by default (2026-07-25): a row inserted without this column is OFF.';
comment on column subscriptions.digest_enabled is
  'Per-user opt-in for the once-a-day digest DM (separate from realtime notify). OPT-IN by default (2026-07-25).';

commit;

-- VERIFY (read-only, after apply):
--   select column_name, column_default from information_schema.columns
--   where table_name = 'subscriptions' and column_name in ('notify','digest_enabled');
--   -- expected: both `false`
--
--   -- and that NO live row moved (compare before/after):
--   select count(*) filter (where notify) as notify_on,
--          count(*) filter (where digest_enabled) as digest_on,
--          count(*) as total
--   from subscriptions;
