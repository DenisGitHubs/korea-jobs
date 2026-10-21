-- draft_0033_featured_ads.sql
-- korea-jobs — «избранные объявления» (owner decision 2026-10-21).
-- ADDITIVE / IDEMPOTENT / NON-DESTRUCTIVE: one new column on user_ads + two partial indexes +
-- one config seed. Nothing existing is dropped, renamed or rewritten.
--
-- WHY
-- An ad an employer posts THROUGH OUR FORM — and which has passed the spam filter and moderation
-- — rides at the TOP of the feed for one week, carrying a badge. Placement is FREE: there is no
-- payment in this project and none is being introduced. The reward is for using the form (a
-- structured, moderated, contactable offer) instead of a channel post we had to scrape.
--
-- 🔴 THIS IS NOT user_ads.promo, AND MUST NEVER BE MERGED WITH IT (draft_0030).
--   promo          = a PAID placement, labelled «Реклама», deliberately given NO ranking privilege
--                    and NEVER pushed to a DM.
--   featured_until = a FREE placement that IS lifted to the top for 7 days and is NOT labelled
--                    «Реклама» (saying "advertising" about a free ad would be a lie on the screen).
-- The two are independent columns on purpose: they mean opposite things and are read by different
-- rules. A promo row is never granted featured (lib/korea/ads/featured.ts guards on it).
--
-- SHAPE — ONE nullable column carries both facts: "is it featured" and "until when".
--   NULL                  = never featured (every row that exists today, and every scraped vacancy
--                           by construction — they are not even in this table);
--   featured_until > now()= featured RIGHT NOW (the feed lifts it and shows the badge);
--   featured_until < now()= its week is over — it sinks back into the ordinary chronological
--                           stream by itself. No sweep, no cron, no second flag to keep in sync:
--                           the expiry IS the comparison in the query (cleanup/run.ts is untouched).
--   A row is granted featured AT MOST ONCE in its life (the grant requires featured_until IS NULL),
--   so an edit / unarchive cycle cannot renew the week.
--
-- ONE PER AUTHOR (owner decision 2026-10-21). While an author has ANY row with
-- featured_until > now(), their next approved ad is published as an ORDINARY one (no grant), so a
-- single employer can never occupy the whole top of the feed. The rule is enforced atomically, in
-- the single UPDATE that grants the week (lib/korea/ads/featured.ts), not by a read-then-write.
--
-- APPLY ORDER. Safe in BOTH orders. The feed/detail/saved queries read the column through
-- `to_jsonb(a) ->> 'featured_until'` (the draft_0030 pattern), so a database without this migration
-- answers "not featured" instead of failing the app's main screen; the grant is best-effort and
-- logs instead of sinking an ad if the column is missing.
--
-- DRAFT — DO NOT APPLY; the internal side applies it (db/apply.mjs, appended to the end of the list).
-- Depends on: user_ads (draft_0003_user_ads.sql) + config (draft_0001_init.sql).

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- user_ads gains ONE column.
-- ─────────────────────────────────────────────────────────────────────────────
alter table user_ads add column if not exists featured_until timestamptz;

comment on column user_ads.featured_until is
  'FREE featured placement (owner 2026-10-21): while featured_until > now() the ad rides at the top of the feed with a badge. NULL = never featured. NOT the same thing as promo (paid «Реклама», no ranking privilege) — never merge the two. Granted at most once per ad, at most one LIVE per author (lib/korea/ads/featured.ts).';

-- The feed asks "is this live ad featured right now" while it sorts; only live rows can matter.
create index if not exists idx_user_ads_featured
  on user_ads (featured_until desc)
  where status = 'approved' and featured_until is not null;

-- The grant asks "does this author already have a live featured ad" (the one-per-author cap).
create index if not exists idx_user_ads_author_featured
  on user_ads (author_user_id, featured_until)
  where featured_until is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Config seed. ON CONFLICT DO NOTHING — an owner-tuned value is never overwritten.
--   ads_featured_days — how long a granted week lasts, in days (owner's number: 7). Tunable
--                       without a deploy; 0 or a negative value effectively switches the perk off
--                       (a granted deadline in the past is simply never "live").
-- ─────────────────────────────────────────────────────────────────────────────
insert into config (key, value) values
  ('ads_featured_days', '7'::jsonb)
on conflict (key) do nothing;

commit;

-- VERIFY (read-only, after apply):
--   -- the column exists and is nullable:
--   select column_name, data_type, is_nullable from information_schema.columns
--    where table_name = 'user_ads' and column_name = 'featured_until';
--
--   -- the two indexes exist:
--   select indexname from pg_indexes
--    where tablename = 'user_ads' and indexname in ('idx_user_ads_featured', 'idx_user_ads_author_featured')
--    order by 1;
--
--   -- nothing is featured yet (expected right after apply: 0):
--   select count(*) from user_ads where featured_until is not null;
--
--   -- the knob:
--   select key, value from config where key = 'ads_featured_days';
--
--   -- SANITY (must stay 0): a PAID placement that was granted the free featured week.
--   select count(*) from user_ads where promo and featured_until is not null;
--
--   -- SANITY (must stay 0): an author with TWO live featured ads at the same time.
--   select count(*) from (
--     select author_user_id from user_ads
--      where featured_until > now() and author_user_id is not null
--      group by author_user_id having count(*) > 1) x;
--
--   -- what is featured right now, newest first (the top of the feed):
--   select id, author_user_id, featured_until, status
--     from user_ads where featured_until > now() order by featured_until desc;
