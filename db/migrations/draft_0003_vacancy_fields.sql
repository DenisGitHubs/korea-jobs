-- draft_0003_vacancy_fields.sql
-- korea-jobs — Phase 1 v2: vacancy attributes (visa / placement fee / housing / meals)
-- + full-text search vector. ADDITIVE ONLY (guarded enums, ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS). Does NOT touch the content_hash generated column.
--
-- Apply order (Neon): 0001 -> seed -> sources_seed -> 0003_vacancy_fields -> ... .
-- See db/apply.mjs `files`.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums (guarded so re-running does not error)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_type where typname = 'visa_type') then
    create type visa_type as enum (
      'any',       -- offer does not restrict by visa
      'e9',        -- EPS non-professional employment
      'e7',        -- skilled worker
      'e8',        -- seasonal work
      'h2',        -- work & visit (ethnic Koreans)
      'f_series',  -- F-2/F-4/F-5/F-6 residency family
      'd_series',  -- D-2/D-4 student, D-10 job-seeker, ...
      'tourist',   -- visa-free / short-stay (often illegal work — flagged, not endorsed)
      'other'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'placement_fee') then
    create type placement_fee as enum ('free', 'paid', 'unknown');
  end if;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- vacancies — new attribute columns.
--   visa_types    : which visas the offer accepts (empty = not stated → permissive).
--   placement_fee : whether the poster charges a placement fee ('unknown' default).
--   has_housing / has_meals : THREE-STATE via nullable boolean
--     (true = provided, false = explicitly not, NULL = not stated).
-- ─────────────────────────────────────────────────────────────────────────────

alter table vacancies
  add column if not exists visa_types    visa_type[]   not null default '{}',
  add column if not exists placement_fee placement_fee not null default 'unknown',
  add column if not exists has_housing   boolean,
  add column if not exists has_meals     boolean;

comment on column vacancies.visa_types    is 'Accepted visa types; empty = not stated (feed/notify treat empty as permissive).';
comment on column vacancies.placement_fee is 'free/paid placement fee; unknown = not stated.';
comment on column vacancies.has_housing   is 'Three-state: true=provided, false=explicitly none, NULL=not stated.';
comment on column vacancies.has_meals     is 'Three-state: true=provided, false=explicitly none, NULL=not stated.';

-- Full-text search. 'simple' config (NO stemming) on purpose: the corpus is
-- multilingual (ru/ko/uz/en) and stemmers are single-language, so 'simple' avoids
-- mangling non-target languages. Queried via websearch_to_tsquery('simple', ...).
alter table vacancies
  add column if not exists search_tsv tsvector generated always as (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))
  ) stored;

create index if not exists idx_vacancies_search on vacancies using gin (search_tsv);

-- ─────────────────────────────────────────────────────────────────────────────
-- kj_content_hash — IMMUTABLE mirror of the vacancies.content_hash GENERATED column
-- expression, used ONLY for the takedown pre-check in the parser (a vacancy's hash is
-- not known until the row is inserted, because content_hash is generated). The
-- generated column itself is intentionally NOT modified (changing its expression would
-- rehash existing rows and split the dedup key).
--
-- ⚠ KEEP THIS EXPRESSION 1:1 IN SYNC WITH the content_hash generated column in
--   draft_0001_init.sql. Any divergence silently breaks the takedown pre-check.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function kj_content_hash(
  p_contact_raw text,
  p_city_id     uuid,
  p_work_type   work_type,
  p_gender      gender,
  p_dedup_extra text
) returns text
language sql
immutable
as $$
  select encode(digest(
    coalesce(kj_normalize_contact(p_contact_raw), 'nocontact') || '|' ||
    coalesce(p_city_id::text, 'nocity')                        || '|' ||
    coalesce(kj_work_type_text(p_work_type), 'nowork')         || '|' ||
    coalesce(kj_gender_text(p_gender), 'any')                  || '|' ||
    coalesce(nullif(btrim(p_dedup_extra), ''), '')
  , 'sha256'), 'hex');
$$;

comment on function kj_content_hash(text, uuid, work_type, gender, text)
  is 'Mirror of vacancies.content_hash generated expression; takedown pre-check ONLY. Keep 1:1 in sync.';
