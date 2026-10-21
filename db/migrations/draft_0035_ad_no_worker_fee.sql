-- draft_0035_ad_no_worker_fee.sql
-- korea-jobs — подтверждение «Я не беру плату с работников» (owner decision 2026-10-21).
-- ADDITIVE / IDEMPOTENT / NON-DESTRUCTIVE: one new column on user_ads. Nothing existing is
-- dropped, renamed or rewritten.
--
-- WHY A SERVER COLUMN AND NOT A CHECKBOX
-- The placement form gets a MANDATORY checkbox «Я не беру плату с работников». A checkbox that
-- only lives in the client is not a confirmation: it can be bypassed by anyone who posts to the
-- API directly, and in a dispute there is nothing to show. The whole point of asking is to HAVE a
-- ground for removing the ad of an agency that charges workers — so the confirmation has to be a
-- record on the ad itself, written by the server at the moment it accepted the ad.
--
-- 🔴 NOTE ON THE OTHER CONSENT IN THE SAME FORM. The existing line «За содержание объявления
-- отвечаю я» (app ru.ts post.consent) is CLIENT-ONLY: the app keeps it in localStorage
-- ('kj:ads-consent') and never sends it, so there was NO existing per-ad consent record to copy —
-- this column is the first one. The right follow-up is to persist that older consent the SAME way
-- (one timestamptz column written by the create path), NOT to invent a second mechanism; said out
-- loud here so the next reader does not build a parallel one.
--
-- SHAPE — a TIMESTAMP, not a boolean: it answers both questions at once, "did the author confirm"
-- and "when". NULL means "no confirmation on file" — which is also the state of every ad created
-- before this rule existed, and those are left exactly as they are (no backfill: we cannot invent
-- a confirmation nobody gave).
--
-- WHO WRITES IT. Exactly one place: POST /api/ads (lib/korea/ads/rw.ts), at creation. A create
-- WITHOUT the confirmation is refused outright (400, detail 'no_worker_fee_confirmation_required')
-- — never silently stored as "false". Nothing else writes the column: the edit (PATCH /api/ads/:id)
-- and the unarchive deliberately do not mention it, so editing an ad can neither lose nor withdraw
-- a confirmation that was already given.
--
-- DRAFT — DO NOT APPLY; the internal side applies it (db/apply.mjs, appended to the end of the list).
-- Depends on: user_ads (draft_0003_user_ads.sql).

begin;

alter table user_ads add column if not exists no_worker_fee_confirmed_at timestamptz;

comment on column user_ads.no_worker_fee_confirmed_at is
  'When the author confirmed «Я не беру с работников плату ВПЕРЁД — за место, визу, оформление» in the placement form (owner 2026-10-21). 🔴 The wording is NARROW on purpose and must match what the person was actually shown (i18n post.noFeeCheck + Правила размещения §5): the form itself lets an author declare «Комиссия за трудоустройство: Платно», and the safety screen says a salary commission «берут часто — так бывает». A record must never describe more than the screen promised. Written ONLY by POST /api/ads at creation; a create without the confirmation is refused, so a NULL here means either an ad from before the rule or an ad created by a path that must not exist. Never overwritten by an edit/unarchive — a confirmation cannot be withdrawn by editing the text.';

-- The dispute question is "which ads carry no confirmation": a partial index keeps that cheap on
-- the live set without indexing the (eventually much larger) confirmed majority.
create index if not exists idx_user_ads_no_fee_missing
  on user_ads (created_at desc)
  where no_worker_fee_confirmed_at is null;

commit;

-- VERIFY (read-only, after apply):
--   select column_name, data_type, is_nullable from information_schema.columns
--    where table_name = 'user_ads' and column_name = 'no_worker_fee_confirmed_at';
--
--   select indexname from pg_indexes
--    where tablename = 'user_ads' and indexname = 'idx_user_ads_no_fee_missing';
--
--   -- the split right after apply: every existing row is "no confirmation on file" (expected),
--   -- and the number must stop growing once the code deploy lands.
--   select (no_worker_fee_confirmed_at is null) as missing, count(*)
--     from user_ads group by 1 order by 1;
--
--   -- SANITY after the code deploy (must stay 0): an ad created AFTER the deploy without a
--   -- confirmation. Replace the moment with the deploy time.
--   select count(*) from user_ads
--    where created_at > '2026-10-21T00:00:00Z'::timestamptz and no_worker_fee_confirmed_at is null;
