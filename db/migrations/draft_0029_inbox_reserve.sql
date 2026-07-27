-- draft_0029_inbox_reserve.sql
-- korea-jobs — «написали в бот»: newcomer reserve + the owner's "ceiling exhausted" warning.
-- ADDITIVE / IDEMPOTENT / NON-DESTRUCTIVE (one new column with a default + one index + one config
-- seed; no existing row changes meaning, no data is moved or deleted).
--
-- WHY (007, major)
-- draft_0028 gave the inbox two ceilings: user_inbox_per_hour (5) per sender and
-- inbox_global_per_day (200) across everyone. Two flooders at 5/h produce 240 forwards a day, so
-- they alone can hold the global window shut. After that a REAL request — «уберите мой номер» —
-- got a polite reply, was NOT forwarded to the admins and was NOT stored anywhere (the ledger
-- keeps no message text, on purpose), i.e. the request vanished without a trace and the owner
-- never learned it existed. That breaks the published Privacy Policy promise («ответим в течение
-- 3 рабочих дней»).
--
-- WHAT THIS ADDS
--   1. bot_inbox.kind — 'message' (default, everything that exists today), 'reserve' (a forward
--      that got through ON TOP of a full global window because it was the sender's FIRST message
--      in 24h) or 'alert' (the marker that says the admins were already warned in this window).
--      One column serves both new mechanisms, so the ledger stays a single small table.
--   2. config inbox_newcomer_reserve_per_day = 30 — how many such first-time forwards may pass
--      over a full global window per 24h. A flooder cannot eat this budget: their second message
--      of the day is no longer a first one. Tunable without a deploy, like the other two knobs.
--
-- STILL METADATA ONLY. `kind` describes HOW a row got through, never WHAT was written. The message
-- text stays out of the database (it lives in the admin's Telegram chat, which the owner answers
-- from) — draft_0028's rule is unchanged.
--
-- THE ALERT ROW. lib/korea/bot/inbox.ts claims it with
--   insert ... select 0, ..., false, 'alert' where not exists (alert row younger than 24h)
-- so the warning DM is sent at most once per window even if a hundred messages hit the ceiling.
-- It uses from_id = 0 (no Telegram account has that id) and forwarded = false, so it can never be
-- counted as somebody's forward or as their "we already answered you" note.
--
-- RETENTION is unchanged: cleanup/run.ts drops every bot_inbox row older than 30 days, alert and
-- reserve rows included.
--
-- DEPLOY ORDER: apply BEFORE the matching code deploy. If the code lands first, the claim
-- statement that names `kind` fails, inbox.ts retries the pre-0029 claim (plain per-hour +
-- per-day ceilings, no reserve, no alert) and nothing is lost — it just behaves like today until
-- this file is applied.
--
-- Depends on: bot_inbox (draft_0028_bot_inbox.sql) + config (draft_0001_init.sql).
--
-- DRAFT — DO NOT APPLY; the internal side applies it (db/apply.mjs, appended to the end of the list).

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- bot_inbox.kind — how this row came to be. NOT NULL + default keeps every existing row valid
-- ('message'), so the column can be added to a live table without touching data.
-- ─────────────────────────────────────────────────────────────────────────────
alter table bot_inbox add column if not exists kind text not null default 'message';

comment on column bot_inbox.kind is
  'How the row came to be: message = ordinary forward or throttle marker; reserve = forward let through over a FULL global window because it was the sender''s first message in 24h; alert = marker that the admins were already warned about the exhausted ceiling in this window (from_id 0, forwarded false).';

-- Serves BOTH new lookups: the 24h reserve count (kind = 'reserve') and the once-per-window alert
-- check (kind = 'alert'). Deliberately NOT partial: the table is tiny (bounded by the ceilings and
-- a 30-day retention), and a plain composite index needs no predicate-implication proof from the
-- planner for either query.
create index if not exists idx_bot_inbox_kind_created on bot_inbox (kind, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Config seed. ON CONFLICT DO NOTHING — an owner-tuned value is never overwritten.
-- ─────────────────────────────────────────────────────────────────────────────
insert into config (key, value) values
  ('inbox_newcomer_reserve_per_day', '30'::jsonb)
on conflict (key) do nothing;

commit;

-- VERIFY (read-only, after apply):
--   -- the column exists and every old row reads 'message':
--   select kind, count(*) from bot_inbox group by kind order by kind;
--
--   -- the new index is there:
--   select indexname from pg_indexes where tablename = 'bot_inbox' order by indexname;
--
--   -- the three knobs (expected 5 / 200 / 30 unless already tuned):
--   select key, value from config
--   where key in ('user_inbox_per_hour', 'inbox_global_per_day', 'inbox_newcomer_reserve_per_day');
--
--   -- how the last 24h went: normal forwards, reserve rescues, throttled, and whether the owner
--   -- was warned:
--   select kind,
--          count(*) filter (where forwarded)     as forwarded,
--          count(*) filter (where not forwarded) as not_forwarded
--   from bot_inbox where created_at > now() - interval '24 hours' group by kind order by kind;
--
-- TO RAISE THE CEILING (no deploy):
--   update config set value = '400'::jsonb where key = 'inbox_global_per_day';
-- TO WIDEN THE NEWCOMER RESERVE:
--   update config set value = '50'::jsonb  where key = 'inbox_newcomer_reserve_per_day';
