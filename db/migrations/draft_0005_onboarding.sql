-- draft_0005_onboarding.sql
-- korea-jobs — Phase 2 redesign: one-time onboarding flag.
-- ADDITIVE ONLY. A nullable timestamp on users:
--   NULL      = the user has not finished the one-time onboarding yet;
--   timestamp = when they completed it.
-- GET /api/me returns `onboarded: boolean` (onboarded_at is not null) so the client can
-- show the onboarding screen exactly once; POST /api/onboarded stamps it (first call
-- wins, idempotent). Safe to re-run (ADD COLUMN IF NOT EXISTS).

alter table users
  add column if not exists onboarded_at timestamptz;

comment on column users.onboarded_at is
  'When the user completed the one-time onboarding; NULL = not yet (drives the first-run onboarding screen via /api/me onboarded + POST /api/onboarded).';
