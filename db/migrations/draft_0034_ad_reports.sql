-- draft_0034_ad_reports.sql
-- korea-jobs — жалобы на ОБЪЯВЛЕНИЯ (Законник + owner decision 2026-10-21).
-- ADDITIVE / IDEMPOTENT / NON-DESTRUCTIVE: one new table + two indexes. Nothing existing is
-- dropped, renamed or rewritten.
--
-- WHY THIS TABLE HAS TO EXIST AT ALL
-- The app already shows a "пожаловаться" action on an OPEN CARD, and an open card can be a USER AD
-- (the detail endpoint serves both kinds). But vacancy_reports.vacancy_id is a NOT NULL foreign key
-- into vacancies, and POST /api/vacancies/:id/report looks the id up in `vacancies` only — so a
-- complaint about a user ad answered 404 and went NOWHERE. It could not be stored even in theory:
-- an ad id violates that FK.
--
-- The shape mirrors the split the project already made for the same reason one table down:
-- contact_reveals (FK -> vacancies) + ad_contact_reveals (FK -> user_ads), counted together against
-- ONE per-user daily budget. Same here: ad_reports is the ad-side twin of vacancy_reports, and the
-- per-user 24h report cap is kept SEPARATE for the two tables ON PURPOSE (lib/korea/reports/rw.ts:21-23),
-- unlike the reveal pair above: 20 vacancy reports AND 20 ad reports per 24h, i.e. 40 in total.
-- Making the older vacancy branch count a table that may not exist yet would turn an unapplied
-- migration into a 500 on every complaint. Repeats are stopped by UNIQUE(user, ad), not by the cap.
--
-- WHAT A COMPLAINT DOES TO A FEATURED AD (Законник)
-- The FIRST complaint withdraws the FREE top-of-feed lift (user_ads.featured_until is expired,
-- draft_0033) and leaves the AD ITSELF live and visible until a human looks at it. Withdrawing a
-- bonus we grant by our own mechanics promises nothing to anybody; removing an ad is a different
-- decision and stays with a human. Owner rule from vacancy reports is unchanged: reports NOTIFY,
-- nothing is hidden automatically.
--
-- PERSONAL DATA. A row here is a PERSON's action (user_id) — so it is deleted by the erasure sweep
-- exactly like vacancy_reports (lib/korea/cleanup/inactive.ts, both triggers). It stores no text of
-- the ad and no contact: a user_id, an ad id, the free-text reason the reporter typed, a timestamp.
--
-- DRAFT — DO NOT APPLY; the internal side applies it (db/apply.mjs, appended to the end of the list).
-- Depends on: users + user_ads (draft_0001 / draft_0003_user_ads).

begin;

create table if not exists ad_reports (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id)    on delete cascade,
  user_ad_id uuid not null references user_ads (id) on delete cascade,
  reason     text,
  created_at timestamptz not null default now(),
  constraint uq_ad_reports_user_ad unique (user_id, user_ad_id)
);

comment on table ad_reports is
  'User-submitted reports on a USER AD; the ad-side twin of vacancy_reports (which can only point at a scraped vacancy). UNIQUE(user, ad) = at most one per user. The FIRST report expires the ad''s free featured lift (user_ads.featured_until) and leaves the ad itself live for a human to judge. Deleted by the erasure sweep like every other table keyed on a person.';

-- "How many reports does this ad have" (the admin DM's running total).
create index if not exists idx_ad_reports_ad    on ad_reports (user_ad_id);
-- The per-user 24h cap, shared with vacancy_reports.
create index if not exists idx_ad_reports_daily on ad_reports (user_id, created_at);

commit;

-- VERIFY (read-only, after apply):
--   select to_regclass('public.ad_reports') is not null as table_exists;
--
--   select indexname from pg_indexes
--    where tablename = 'ad_reports' order by 1;
--
--   -- nothing reported yet (expected right after apply: 0):
--   select count(*) from ad_reports;
--
--   -- SANITY (must stay 0): a reported ad that still carries a LIVE featured lift.
--   select count(*) from user_ads a
--    where a.featured_until > now()
--      and exists (select 1 from ad_reports r where r.user_ad_id = a.id);
