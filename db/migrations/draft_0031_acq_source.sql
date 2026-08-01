-- draft_0031_acq_source.sql
-- korea-jobs — «откуда пришёл человек»: метка источника из deep-link (2026-08-01).
-- ADDITIVE / IDEMPOTENT / NON-DESTRUCTIVE: ONE nullable column on users + ONE partial index.
-- Nothing is dropped, renamed, backfilled or rewritten; every existing row keeps acq_source NULL.
--
-- WHY
-- The owner launches Telegram Ads and puts a labelled link into «URL to promote»:
--     https://t.me/korea_rabota_bot/app?startapp=ads_ru1   (Mini App — the recommended one)
--     https://t.me/korea_rabota_bot?start=ads_ru1          (bot)
-- Until now that label was parsed as garbage and silently dropped, so «сколько людей дала
-- реклама» had no answer. The parser (lib/korea/core/start-param.ts) now recognises the shapes
-- `ads_<slug>` (advertising) and `s_<slug>` (any other channel), and both entry paths (Mini App
-- auth upsert — core/context.ts; bot /start — bot/webhook.ts) store the label here VERBATIM:
-- what the owner typed into the cabinet is what /stats prints back.
--
-- IMMUTABLE, FIRST TOUCH ONLY. acq_source is written ONLY in the INSERT part of the upsert; the
-- ON CONFLICT branch never mentions it. Consequences, on purpose:
--   * a second visit, a different campaign link, or a later referral link CANNOT overwrite it;
--   * an ALREADY EXISTING user who taps the ad is NOT counted — the ad did not acquire them.
--     («Сколько людей дала реклама» must mean NEW people, otherwise the number flatters itself.)
--
-- SEPARATE FROM THE REFERRAL GRAPH. acq_source lives beside referred_by/ref_l2/ref_l3 and never
-- touches them: a person who came from an ad has NO inviter, earns nobody referral points and is
-- absent from «пришли по рефералке». The start_param formats are disjoint by construction (a
-- campaign label contains `_`, which is not a hex digit), so one link can never be both.
--
-- NOT PII. The value is a campaign label the owner invented («ads_ru1»), identical for thousands
-- of people — it says nothing about the person. That is why the erase/anonymize path
-- (lib/korea/cleanup/inactive.ts) deliberately leaves it in place: an erased account stays an
-- anonymous node whose acquisition history other numbers depend on.
--
-- ⚠ THAT SENTENCE IS ONLY TRUE BECAUSE OF draft_0032. `?startapp=` is a public URL tail: on its
-- own, this column would accept any well-formed string ANY visitor cared to invent about himself,
-- and keep it past account erasure. draft_0032 adds the ALLOW-LIST (config acq_sources_allowed +
-- the gate in lib/korea/core/acq-source.ts) that makes "a campaign label the owner invented"
-- literally true — apply the two together, and never re-open the write path without it.
--
-- NO CHECK CONSTRAINT ON PURPOSE. The legal shape of a slug is defined once, in
-- lib/korea/core/start-param.ts (SOURCE_RE). Restating it in SQL would give two definitions that
-- drift apart on the first change; the column just stores what the single parser produced
-- (4..32 chars of [a-z0-9_], lowercase).
--
-- DRAFT — DO NOT APPLY; the internal side applies it (db/apply.mjs, appended to the end of the
-- list). Depends on: users (draft_0001).

begin;

alter table users add column if not exists acq_source text;

comment on column users.acq_source is
  'Acquisition label from the deep link (`ads_<slug>` or `s_<slug>`, e.g. ads_ru1): WHERE this user came from, stored verbatim. Written ONCE, on INSERT only — never overwritten by a later visit/link, never set for an already-existing user. Not personal data (a shared campaign label); survives erase. Shape is validated in code (core/start-param.ts, 4..32 chars), not by a CHECK.';

-- The /stats report is exactly: "group by acq_source" + "and how many of those in the last 7
-- days". A partial index keeps it off a full users scan while costing nothing on the (vast)
-- majority of rows, which carry no label at all.
create index if not exists idx_users_acq_source
  on users (acq_source, created_at desc)
  where acq_source is not null;

commit;

-- VERIFY (read-only, after apply):
--   -- the column and the index exist:
--   select column_name, data_type from information_schema.columns
--    where table_name = 'users' and column_name = 'acq_source';
--   select indexname from pg_indexes where tablename = 'users' and indexname = 'idx_users_acq_source';
--
--   -- nobody is labelled yet (expected right after apply — the label is INSERT-only):
--   select acq_source, count(*) from users where acq_source is not null group by 1 order by 2 desc;
--
--   -- the same numbers /stats prints (total + last 7 days):
--   select acq_source,
--          count(*)::int as total,
--          count(*) filter (where created_at > now() - interval '7 days')::int as week
--     from users where acq_source is not null group by 1 order by 2 desc, 1;
--
--   -- OVERLAP (expected to be small, NOT zero): a person can carry both a label and an inviter.
--   -- One LINK carries only one of the two shapes, but a life is longer than one link: someone
--   -- who arrived from an ad can still be bound to an inviter later, inside the binding window
--   -- (referral_bind_window_hours, 72h) and before their first contact reveal — see context.ts.
--   -- So the two /stats blocks may overlap; they are not disjoint sets and must not be summed.
--   select count(*) from users where acq_source is not null and referred_by is not null;
