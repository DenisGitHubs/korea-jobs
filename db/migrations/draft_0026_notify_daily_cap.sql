-- draft_0026_notify_daily_cap.sql
-- korea-jobs — PER-USER DAILY CAP on realtime notification DMs (owner, 2026-07-26).
-- ADDITIVE / IDEMPOTENT / NON-DESTRUCTIVE.
--
-- WHY
-- There is currently NO per-person daily ceiling. The only limits are per RUN: 10 offers scanned,
-- 6 offers per DM, 200 DMs per run across everyone (lib/korea/notify/run.ts). The cron fires every
-- 3 minutes (~480 runs/day) and each run sends at most ONE grouped DM per user, so one person can
-- legitimately collect hundreds of DMs a day. Measured live: 77 DMs to one user on 19.07, 56 on
-- 20.07 (8 of 10 subscribers have picked neither a city nor a region, so they match everything).
-- The settings screen now lets a person choose their own ceiling.
--
-- SEMANTICS OF subscriptions.notify_daily_cap  (integer, NULLABLE, NO DEFAULT)
--   * NULL      = NO LIMIT. This is the value every row holds — old and new alike — until the
--                 person picks a number on the settings screen. It is byte-for-byte today's
--                 behaviour.
--   * 1 .. 500  = at most that many notification DMs per Asia/Seoul CALENDAR DAY.
--   The unit is LETTERS (Telegram messages), NOT vacancies: one DM can carry up to
--   notify_group_cap (6) offers, so cap = 10 means "up to 10 messages", not "up to 10 vacancies".
--   The daily window is the Asia/Seoul calendar day (the audience lives in Korea), the same day
--   definition the streaks (draft_0018) and the digest window use. Seoul has no DST (+9 fixed).
--   The DIGEST is a separate channel (strictly one message a day, digest/run.ts) and is NOT
--   affected by this column.
--
-- NO DEFAULT — owner's decision (2026-07-26): «всем без ограничений. Захотят изменить — то изменят
--   в настройках кол-во». So the column carries NO DEFAULT at all: a subscription created without
--   an explicit choice stores NULL and stays unlimited, exactly like every subscription that
--   existed before this file. A limit exists ONLY because a person chose one.
--
-- NO BACKFILL — deliberate
--   Nobody's mail volume changes when this migration lands: there is no DEFAULT to materialise onto
--   old rows (PG 11+ would do exactly that if one were given here) and there is NO UPDATE in this
--   file. Every existing subscription keeps NULL = unlimited.
--
-- INDEX
--   idx_notif_user_sent_at supports the once-per-run counting query in notify/run.ts:
--   "how many DMs has each candidate already received since Seoul midnight" — a single grouped
--   query over notifications_sent for all candidates of the run (never N+1).
--
-- Re-applying is a no-op (ADD COLUMN IF NOT EXISTS / guarded constraint / CREATE INDEX IF NOT
-- EXISTS).
--
-- APPLY ORDER: this file must be applied BEFORE the matching code deploy — POST /api/subscription
-- and GET /api/me reference the column directly (same convention as draft_0017_digest.sql /
-- draft_0020_city_ids.sql). The notify cron itself degrades to "no caps" if the column is missing.
--
-- Depends on: subscriptions (draft_0001_init.sql), notifications_sent (draft_0001_init.sql,
-- extended by draft_0010_ads_notify.sql).
--
-- DRAFT — DO NOT APPLY; the internal side applies it (db/apply.mjs, appended to the end of the list).

begin;

-- (1) The column itself. NULLABLE and with NO DEFAULT on purpose (owner: everyone unlimited unless
--     they choose otherwise), so every subscription — existing and future — stays NULL = unlimited
--     until its owner picks a number in the settings.
alter table subscriptions
  add column if not exists notify_daily_cap integer;

-- Converge to "no default" even if some earlier copy of this draft had already attached one:
-- `add column if not exists` above would have skipped the column and left that default in place,
-- quietly capping future subscribers. Dropping a default touches NO row data — it only changes what
-- an INSERT without the column stores. A no-op on a column that has no default (the normal case).
alter table subscriptions
  alter column notify_daily_cap drop default;

comment on column subscriptions.notify_daily_cap is
  'Max realtime notification DMs (LETTERS, not vacancies) per Asia/Seoul calendar day. NULL = NO LIMIT and is the state of every row until the user picks a number in the settings (no column default, no backfill; owner 2026-07-26).';

-- (2) Range guard. Every existing row is NULL, so the constraint validates instantly. The API
--     enforces the same 1..500 window and rejects anything else with 400; this is the last line.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_subscriptions_notify_daily_cap') then
    alter table subscriptions
      add constraint chk_subscriptions_notify_daily_cap
      check (notify_daily_cap is null or (notify_daily_cap >= 1 and notify_daily_cap <= 500));
  end if;
end
$$;

-- (3) Counting index for the per-run "DMs already delivered today" query. Partial (only successful
--     deliveries are counted) and ordered by sent_at so the Seoul-midnight range scan is cheap.
create index if not exists idx_notif_user_sent_at
  on notifications_sent (user_id, sent_at)
  where status = 'sent';

commit;

-- VERIFY (read-only, after apply):
--   -- column present, NULLABLE, and with NO default (that empty default is the owner's rule:
--   -- nobody gets a limit they did not choose):
--   select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--   where table_name = 'subscriptions' and column_name = 'notify_daily_cap';
--   -- expected: integer | NULL (empty) | YES
--
--   -- NOT A SINGLE row has a limit (everyone still unlimited):
--   select count(*) as total,
--          count(notify_daily_cap) as with_cap        -- expected: 0 right after apply
--   from subscriptions;
--
--   -- the counting index exists:
--   select indexname from pg_indexes where tablename = 'notifications_sent'
--     and indexname = 'idx_notif_user_sent_at';
--
--   -- how many DMs (not vacancies!) each user got today, Seoul time — the exact expression the
--   -- notify run uses; compare against the caps once people start choosing them:
--   select user_id, count(distinct tg_message_id) as letters_today
--   from notifications_sent
--   where status = 'sent' and tg_message_id is not null
--     and sent_at >= (date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')
--   group by user_id order by letters_today desc;
