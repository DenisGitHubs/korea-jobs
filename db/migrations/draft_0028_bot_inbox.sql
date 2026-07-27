-- draft_0028_bot_inbox.sql
-- korea-jobs — «написали в бот»: rate-limit ledger for messages people send to @korea_rabota_bot.
-- ADDITIVE / IDEMPOTENT / NON-DESTRUCTIVE (one new table + two config seeds, nothing touched).
--
-- WHY
-- The Privacy Policy tells people to write to the bot («напиши нам @korea_rabota_bot») and promises
-- an answer «в течение 3 рабочих дней» — that is the channel for a takedown request («уберите мой
-- номер»), a consent withdrawal and any data question. Until now lib/korea/bot/webhook.ts dropped
-- every non-command message, so the promise could not be kept. The webhook now forwards such a
-- message to the admins (lib/korea/bot/inbox.ts) and answers the sender. This table is the ANTI-SPAM
-- ledger behind that forwarding: without a ceiling one flooder turns the owner's Telegram into
-- noise and the real takedown request drowns.
--
-- WHAT IS STORED — METADATA ONLY, NEVER THE MESSAGE TEXT
--   from_id / chat_id : Telegram ids (needed to count per sender);
--   update_id         : the Telegram update, for tracing a forward back to the webhook ledger;
--   text_len          : LENGTH of the message, so volume can be inspected without keeping content;
--   forwarded         : true  = the message went to the admins and consumed one slot,
--                       false = a "throttled" marker (we told the person we already have their
--                               messages) — it does NOT consume a slot and exists only so the
--                               polite reply is sent ONCE per hour instead of on every message.
-- The text itself deliberately stays OUT of the database: takedown requests carry phone numbers
-- (third-party PII) and the message already lives in the admin's Telegram chat — the copy the owner
-- actually answers from.
--
-- THE LIMITS (config, so they change with no deploy)
--   user_inbox_per_hour  = 5   — forwards per sender per hour;
--   inbox_global_per_day = 200 — forwards in 24h across everyone.
-- Both are seeded here with INSERT ... ON CONFLICT DO NOTHING, so re-applying never overwrites a
-- value the owner has already tuned. Change either with, e.g.:
--   update config set value = '10'::jsonb where key = 'user_inbox_per_hour';
-- The code falls back to the same numbers when a key is missing, so a missing seed is harmless.
-- Setting either knob to 0 is the EMERGENCY STOP: nothing is forwarded any more, and the person
-- still gets a polite "write a bit later" answer instead of silence.
--
-- HOW THE CLAIM WORKS
-- inbox.ts inserts the forwarded row in ONE statement whose WHERE re-counts both windows, so two
-- messages racing through two serverless invocations cannot both slip past a full window. The two
-- partial indexes below are exactly the scans that statement performs.
--
-- RETENTION: the rate windows are 1h/24h, so rows are useless after a day; lib/korea/cleanup/run.ts
-- deletes anything older than 30 days on every cleanup tick (best-effort, so a deploy that lands
-- before this file does not fail the other retention steps). Nothing here grows without bound: a
-- flooder can add at most `user_inbox_per_hour` forwarded rows + 3 markers per hour.
--
-- DEPLOY ORDER: apply BEFORE the matching code deploy. If the code lands first, inbox.ts degrades
-- to counting the sender's updates in bot_updates and still forwards (fail-open by design — a
-- silently dropped takedown request breaks a published promise), so nothing is lost either way.
--
-- Depends on: pgcrypto's gen_random_uuid + config (draft_0001_init.sql).
--
-- DRAFT — DO NOT APPLY; the internal side applies it (db/apply.mjs, appended to the end of the list).

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- bot_inbox — one row per inbound private message we ACTED on (forwarded or throttled).
-- No foreign key to users on purpose: a person can write to the bot before any users row exists
-- (they may never have opened the Mini App), and the ledger must not depend on that.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists bot_inbox (
  id         uuid primary key default gen_random_uuid(),
  from_id    bigint not null,
  chat_id    bigint,
  update_id  bigint,
  text_len   integer,
  forwarded  boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table bot_inbox is
  'Anti-spam ledger for messages written to the bot (lib/korea/bot/inbox.ts). METADATA ONLY — never the message text. forwarded=true consumed a slot and went to the admins; forwarded=false is a "we already answered you this hour" marker. Purged after 30 days by cleanup/run.ts.';
comment on column bot_inbox.text_len is 'Length of the message in characters (content is NOT stored).';
comment on column bot_inbox.forwarded is 'true = delivered to the admins (consumes a per-hour/per-day slot); false = throttle marker.';

-- Per-sender hourly window (the "5 per hour" count) — partial, forwarded rows only.
create index if not exists idx_bot_inbox_from_fwd
  on bot_inbox (from_id, created_at)
  where forwarded;

-- The "did we already answer this person" lookup — partial, markers only.
create index if not exists idx_bot_inbox_from_note
  on bot_inbox (from_id, created_at)
  where not forwarded;

-- Global 24h window (the "200 a day" count) + the retention sweep.
create index if not exists idx_bot_inbox_created
  on bot_inbox (created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Config seeds. ON CONFLICT DO NOTHING — an owner-tuned value is never overwritten.
-- ─────────────────────────────────────────────────────────────────────────────
insert into config (key, value) values
  ('user_inbox_per_hour',  '5'::jsonb),
  ('inbox_global_per_day', '200'::jsonb)
on conflict (key) do nothing;

commit;

-- VERIFY (read-only, after apply):
--   -- the table and its three indexes exist:
--   select indexname from pg_indexes where tablename = 'bot_inbox' order by indexname;
--
--   -- the two knobs (expected: 5 and 200 unless already tuned):
--   select key, value from config where key in ('user_inbox_per_hour', 'inbox_global_per_day');
--
--   -- today's inbox volume (how many people wrote, how many forwards, how many throttled):
--   select count(*) filter (where forwarded)     as forwarded,
--          count(*) filter (where not forwarded) as throttled,
--          count(distinct from_id)               as people
--   from bot_inbox where created_at > now() - interval '24 hours';
--
--   -- who is hitting the per-hour ceiling right now:
--   select from_id, count(*) as forwards_last_hour
--   from bot_inbox
--   where forwarded and created_at > now() - interval '1 hour'
--   group by from_id order by forwards_last_hour desc;
