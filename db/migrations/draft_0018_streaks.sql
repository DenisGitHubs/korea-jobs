-- draft_0018_streaks.sql
-- korea-jobs — daily VISIT & OPEN streaks + one-time 7-day streak bonuses (owner rule
-- 2026-07-20). ADDITIVE ONLY, guarded (idempotent).
--
-- Two independent per-user daily streaks, counted by the Asia/Seoul calendar day
-- (consistent with the digest window / seoulHour — the audience lives in Korea):
--   * VISIT streak — consecutive Seoul-days the user opened the app (authenticate()).
--   * OPEN  streak — consecutive Seoul-days the user opened at least one card, vacancy OR
--                    user ad (vacancyDetail()).
-- Each full multiple of 7 grants a one-time bonus: visit +20, open +30. The bonus amounts
-- are config-tunable (streak_visit_bonus / streak_open_bonus) with those code defaults and
-- deliberately NO seed here (mirrors digest's 'digest_notify_enabled': the fallback lives in
-- getConfigNumber(), so the owner can override without a migration and an unset key just uses
-- the default).
--
-- Why a NEW table (streak_awards) instead of referral_points_ledger: that ledger's
-- activation_id is NOT NULL (draft_0004) — a streak bonus has no activation, so it cannot ride
-- the ledger without weakening that invariant. streak_awards is the streak counterpart of the
-- ledger: append-only, one row per (user, kind, series-length). The loyalty balance stays a
-- DERIVED value — sum(confirmed referral_points_ledger) + sum(streak_awards) — with NO cached
-- column on users (same rationale as draft_0004: a cache drifts). /api/me and /api/referral
-- sum the two truth tables.
--
-- Anti-abuse: the day is credited by the SERVER clock only (Asia/Seoul), at most once per day
-- (the streak statements carry a WHERE guard `*_streak_day is distinct from today`, so
-- concurrent requests for one user cannot double-increment), and unique(user_id, kind,
-- award_day) means at most ONE bonus of a kind can be earned per Seoul-day. A rebuilt streak
-- that honestly reaches 7 again on later days DOES pay again (owner decision 2026-07-21:
-- "каждые 7 дней" applies to a rebuilt series too — those are the same 7 real days of activity,
-- and there is no farm advantage since a kind pays at most once per day and only on a multiple
-- of 7, i.e. at most one bonus of a kind per 7-day window regardless).
--
-- DRAFT — DO NOT APPLY automatically (rule #4). The internal side applies it. Apply order
-- (Neon): after draft_0004_referral.sql (streak_awards is the ledger's counterpart) — it only
-- touches users + config + a new table, so any position after 0001/0004 is fine.

-- ─────────────────────────────────────────────────────────────────────────────
-- users — the two streak counters + the "last credited Seoul day" guards.
--   *_streak     : consecutive-day count; 0 until the first counted day.
--   *_streak_day : the Asia/Seoul calendar day the streak was last advanced (nullable; the
--                  once-per-day WHERE guard compares against it with IS DISTINCT FROM).
-- ─────────────────────────────────────────────────────────────────────────────
alter table users
  add column if not exists visit_streak     integer not null default 0,
  add column if not exists visit_streak_day date,
  add column if not exists open_streak      integer not null default 0,
  add column if not exists open_streak_day  date;

comment on column users.visit_streak     is 'Consecutive Asia/Seoul days the user opened the app; 0 until the first counted visit.';
comment on column users.visit_streak_day is 'Asia/Seoul day the visit streak was last advanced (the once-per-day guard).';
comment on column users.open_streak      is 'Consecutive Asia/Seoul days the user opened at least one card (vacancy/ad detail).';
comment on column users.open_streak_day  is 'Asia/Seoul day the open streak was last advanced (the once-per-day guard).';

-- ─────────────────────────────────────────────────────────────────────────────
-- streak_awards — streak bonuses (the streak counterpart of referral_points_ledger).
-- unique(user_id, kind, award_day): a kind pays out at most once per Seoul-day — the idempotency
-- anchor against double-grants on a race (concurrent requests for one user share the same
-- award_day) while still paying an honest rebuilt series that reaches 7 again on a later day.
-- streak_len is kept purely informational (the series length that fired the bonus). amount is a
-- config snapshot at award time (config may change later without rewriting history).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists streak_awards (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid    not null references users (id) on delete cascade,
  kind       text    not null,                 -- 'visit' | 'open'
  amount     integer not null,                 -- points granted (>0)
  streak_len integer not null,                 -- informational: series length that fired it (a multiple of 7)
  award_day  date    not null,                 -- Asia/Seoul day the multiple of 7 was reached — the idempotency anchor
  awarded_at timestamptz not null default now(),
  constraint uq_streak_awards      unique (user_id, kind, award_day),
  constraint ck_streak_awards_kind check (kind in ('visit', 'open'))
);

comment on table streak_awards is 'Streak bonuses; unique(user_id,kind,award_day) = a kind pays out at most once per Seoul-day (a rebuilt series that re-reaches 7 on a later day pays again). streak_len is informational. Balance += sum(amount).';

create index if not exists idx_streak_awards_user on streak_awards (user_id);
