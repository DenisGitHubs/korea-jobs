-- draft_0010_ads_notify.sql
-- korea-jobs — push notifications for APPROVED user ads + free-text city on the ad form.
-- Subscribers already get a DM when a matching vacancy lands (notifications_sent + the notify
-- cron); this extends the exact same machinery to user-submitted ads so "Разместить" postings
-- reach the same audience. Two shape changes:
--   (1) user_ads.city_text — the free-text city typed when the author picks "Другое" (no city
--       from the directory). Only ever set when city_id is null; capped to ~60 chars in code.
--   (2) user_ads.notify_pending — mirror of vacancies.notify_pending: true until the notify
--       cron has swept an approved ad, false afterwards (or immediately for a city-less ad,
--       which is never pushed — subscriptions are city-scoped).
--   (3) notifications_sent gains ad_id and becomes "one of vacancy_id / ad_id": the dedup
--       ledger now records "user U was told about ad A" as well as "... vacancy V". A guarded
--       CHECK enforces exactly one target; a partial UNIQUE (user_id, ad_id) is the ad-side
--       twin of uq_notif_user_vac. The existing uq_notif_user_vac is left untouched.
--
-- ADDITIVE ONLY. Guarded (IF NOT EXISTS / DO-blocks). DRAFT — DO NOT APPLY; the internal side
-- applies it. Depends on: user_ads (draft_0003_user_ads.sql), notifications_sent
-- (draft_0001_init.sql).

-- ─────────────────────────────────────────────────────────────────────────────
-- (1)+(2) user_ads — free-text city + notify flag.
-- ─────────────────────────────────────────────────────────────────────────────

alter table user_ads
  add column if not exists city_text      text,
  add column if not exists notify_pending boolean not null default false;

comment on column user_ads.city_text is
  'Free-text city the author typed under "Другое"; set ONLY when city_id is null. Capped to ~60 chars in the API.';
comment on column user_ads.notify_pending is
  'Mirror of vacancies.notify_pending: true until the notify cron has swept an APPROVED ad; a city-less ad is cleared to false without a push.';

-- Sweep lookup for the notify cron: approved + still-pending ads, oldest first. Partial so it
-- stays lean (only the tiny set awaiting a push is indexed), matching idx_vacancies_notify_pending.
create index if not exists idx_user_ads_notify_pending
  on user_ads (created_at)
  where notify_pending and status = 'approved';

-- ─────────────────────────────────────────────────────────────────────────────
-- (3) notifications_sent — allow an ad target alongside a vacancy target.
-- ─────────────────────────────────────────────────────────────────────────────

-- vacancy_id was NOT NULL (vacancy-only ledger). Relax it so an ad row can carry ad_id instead.
-- DROP NOT NULL is a no-op when already dropped → re-runnable.
alter table notifications_sent
  alter column vacancy_id drop not null;

-- ad_id — the ad-side twin of vacancy_id. FK cascades so purging an ad clears its push history.
alter table notifications_sent
  add column if not exists ad_id uuid references user_ads (id) on delete cascade;

comment on column notifications_sent.ad_id is
  'Target user_ad for an ad push; mutually exclusive with vacancy_id (see chk_notif_one_target).';

-- Exactly one of (vacancy_id, ad_id) is set — a push is about a vacancy XOR an ad. All pre-existing
-- rows have vacancy_id set + ad_id null (num_nonnulls = 1), so the constraint validates cleanly.
-- Guarded by conname so re-applying the file is a no-op.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_notif_one_target') then
    alter table notifications_sent
      add constraint chk_notif_one_target
      check (num_nonnulls(vacancy_id, ad_id) = 1);
  end if;
end
$$;

-- Ad-side dedup: one push per (user, ad). Partial (ad_id is not null) so the vacancy rows
-- (ad_id null) are excluded — the ad twin of uq_notif_user_vac, which is left as-is.
create unique index if not exists uq_notif_user_ad
  on notifications_sent (user_id, ad_id)
  where ad_id is not null;
