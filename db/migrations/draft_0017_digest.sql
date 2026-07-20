-- draft_0017_digest.sql
-- korea-jobs — once-a-day matched-vacancy DIGEST (owner rule 2026-07-20). ADDITIVE ONLY, guarded.
--
-- A dedicated cron (POST /api/cron/digest -> lib/korea/digest/run.ts) DMs each opted-in subscriber
-- ONE "N new vacancies matching your filters" line per morning (09:00–12:00 Asia/Seoul). It is
-- self-throttled to at most once / 22h via the GLOBAL config marker 'digest_last_run' (an epoch
-- seconds number, upserted atomically by the run itself — no seed here), plus a PER-USER dedup on
-- subscriptions.last_digest_at (>22h). The endpoint is polled every ~3 min by the existing external
-- scheduler and decides for itself whether it is time.
--
--   * subscriptions.digest_enabled — per-user opt-in for the daily digest, INDEPENDENT of the
--     realtime `notify` push. Default TRUE so existing rows stay opted in; POST /api/subscription
--     accepts it alongside `notify`.
--   * subscriptions.last_digest_at — the run stamps it on a delivered digest and only picks users
--     whose last digest is NULL or older than 22h. No extra "sent today" table needed.
--
-- No config seed is required: 'digest_last_run' is created by the run's upsert; the two columns
-- carry defaults. Matching is the SAME permissive logic as notify/run.ts (empty/NULL passes; only
-- an EXPLICIT contradiction excludes). DRAFT — DO NOT APPLY; the internal side applies it.

alter table subscriptions
  add column if not exists digest_enabled boolean not null default true,
  add column if not exists last_digest_at timestamptz;

comment on column subscriptions.digest_enabled is 'Per-user opt-in for the once-a-day digest DM (separate from realtime notify).';
comment on column subscriptions.last_digest_at is 'When the last digest DM was delivered to this user; drives the >22h per-user dedup.';

-- Partial index over the digest run''s working set: opted-in subscribers, ordered by last digest.
create index if not exists idx_subscriptions_digest
  on subscriptions (last_digest_at)
  where notify and digest_enabled;
