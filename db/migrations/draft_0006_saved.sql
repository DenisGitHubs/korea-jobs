-- draft_0006_saved.sql
-- korea-jobs — Phase 3a redesign: SAVED vacancies ("Сохранённые" / bookmarks).
--
-- A user's PRIVATE bookmark lists over BOTH feed sources: scraped `vacancies` and
-- user-submitted `user_ads`. Mirrors the contact_reveals / ad_contact_reveals split —
-- two tables with distinct FK targets — so we keep referential integrity per source
-- instead of a polymorphic (kind,id) column with no FK. The API scopes every read to
-- the authenticated user (see draft_0002_rls.sql note: on Neon security lives in the
-- serverless layer, not RLS — these tables carry no RLS, exactly like the *_reveals ones).
--
-- ADDITIVE ONLY. Guarded (IF NOT EXISTS). DRAFT — DO NOT APPLY; the internal side applies it.
-- Depends on: users, vacancies (draft_0001_init.sql), user_ads (draft_0003_user_ads.sql).

-- ─────────────────────────────────────────────────────────────────────────────
-- saved_vacancies — a user's bookmarks on SCRAPED vacancies. PK (user_id, vacancy_id)
-- makes a re-save a no-op (idempotent `on conflict do nothing`). Stores only the FACT
-- of a bookmark + when it was made; nothing sensitive. Both FKs cascade, so deleting a
-- user or a vacancy cleans up its bookmarks automatically.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists saved_vacancies (
  user_id    uuid not null references users (id)     on delete cascade,
  vacancy_id uuid not null references vacancies (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, vacancy_id)
);

comment on table saved_vacancies is 'Per (user, vacancy) bookmark on a scraped vacancy; private to the user, newest-first paged by created_at.';

-- Drives GET /api/saved (a user's own list, newest bookmark first) + its cursor.
create index if not exists idx_saved_vacancies_user on saved_vacancies (user_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- saved_ads — a user's bookmarks on USER ADS. Separate table (FK to user_ads) so it does
-- not collide with saved_vacancies (FK to vacancies) — the same pattern as
-- ad_contact_reveals vs contact_reveals. The API pages BOTH tables into one saved feed.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists saved_ads (
  user_id    uuid not null references users (id)    on delete cascade,
  ad_id      uuid not null references user_ads (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, ad_id)
);

comment on table saved_ads is 'Per (user, user_ad) bookmark on a user-submitted ad; private to the user, shares the saved feed with saved_vacancies.';

create index if not exists idx_saved_ads_user on saved_ads (user_id, created_at desc);
