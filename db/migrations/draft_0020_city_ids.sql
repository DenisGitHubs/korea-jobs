-- draft_0020_city_ids.sql
-- korea-jobs — MULTI-CITY vacancies / user ads + a per-subscription "no_city" toggle.
-- ADDITIVE ONLY, guarded, fully idempotent (apply.mjs re-runs the WHOLE list every apply).
--
-- What & why:
--   * vacancies.city_ids / user_ads.city_ids (uuid[] not null default '{}') — the FULL set of cities
--     an offer names (a post can be about several: "работа в Сеуле и Ансане"). The existing single
--     city_id stays the PRIMARY city (untouched, still drives content_hash + the "main" display);
--     city_ids is the additive superset the parser/backfill fill from the text + source hint.
--   * subscriptions.no_city (boolean not null default true) — when a subscriber HAS picked at least
--     one city, whether to ALSO see city-less offers (city_ids empty). Default true = unchanged
--     behaviour (city-less offers still shown). Ignored entirely when no city is selected.
--   * kj_city_match(sel, det, u) — the SINGLE immutable predicate shared by the feed and the digest,
--     so the two never drift. Semantics (owner/Sanya-approved):
--       cardinality(sel)=0                       -> true   (no city filter -> show everything)
--       cardinality(det)>0 and (sel && det)      -> true   (offer's cities overlap the selection)
--       cardinality(det)=0 and u                 -> true   (city-less offer, and "show city-less" on)
--       else                                     -> false
--
-- content_hash / kj_content_hash / city_id are NOT touched by ANY statement here.
--
-- DRAFT — DO NOT APPLY; the internal side applies it (apply.mjs, appended to the end of the list).

-- ── Columns (additive, guarded) ───────────────────────────────────────────────────────────────
alter table vacancies    add column if not exists city_ids uuid[] not null default '{}';
alter table user_ads     add column if not exists city_ids uuid[] not null default '{}';
alter table subscriptions add column if not exists no_city boolean not null default true;

comment on column vacancies.city_ids is 'All cities this offer names (superset of city_id); city_id stays the PRIMARY. Filled by the parser/backfill from text + source hint.';
comment on column user_ads.city_ids is 'All cities this ad names (superset of city_id); city_id (from the form) stays the PRIMARY.';
comment on column subscriptions.no_city is 'When a city filter IS set: also show city-less offers (city_ids empty). Default true. Ignored when no city is selected.';

-- ── Guarded seed of city_ids from the existing single city_id ─────────────────────────────────
-- ONLY where a city_id exists AND city_ids is still empty. The `cardinality = 0` guard makes this
-- idempotent on every re-apply AND non-destructive: a row already enriched with several cities (by
-- the parser or db/backfill_city_ids.mts) is NEVER reset back to just [city_id]. city_id itself is
-- read-only here.
update vacancies set city_ids = array[city_id]
  where city_id is not null and cardinality(city_ids) = 0;
update user_ads set city_ids = array[city_id]
  where city_id is not null and cardinality(city_ids) = 0;

-- ── Partial GIN indexes over the live working sets ────────────────────────────────────────────
-- Mirror the existing single-city partial indexes' predicates so the planner can use city_ids for
-- the feed's kj_city_match / notify's overlap without scanning dead rows.
create index if not exists idx_vacancies_city_ids
  on vacancies using gin (city_ids)
  where is_active and duplicate_of is null;
create index if not exists idx_user_ads_city_ids
  on user_ads using gin (city_ids)
  where status = 'approved';

-- ── Shared city-match predicate (immutable -> usable in indexes/generated exprs; drift-proof) ──
-- Coalesce guards keep it total even if a NULL array is ever passed (the columns are NOT NULL, so
-- on the hot path these are no-ops). See the header for the truth table.
create or replace function kj_city_match(sel uuid[], det uuid[], u boolean)
returns boolean
language sql
immutable
as $$
  select case
    when cardinality(coalesce(sel, '{}'::uuid[])) = 0 then true
    else (
      (cardinality(coalesce(det, '{}'::uuid[])) > 0 and (coalesce(sel, '{}'::uuid[]) && coalesce(det, '{}'::uuid[])))
      or (cardinality(coalesce(det, '{}'::uuid[])) = 0 and coalesce(u, true))
    )
  end;
$$;

comment on function kj_city_match(uuid[], uuid[], boolean) is 'Shared city-filter predicate (selected, detected, show-city-less): empty selection -> all; else overlap OR (city-less AND show-city-less).';
