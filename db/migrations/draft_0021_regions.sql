-- draft_0021_regions.sql
-- korea-jobs — REGION geo layer (province filtering) + conditional AI-geo LEARNING tables.
-- ADDITIVE ONLY, guarded, fully idempotent (apply.mjs re-runs the WHOLE list every apply).
--
-- PART A — REGIONS
--   * vacancies.region_slugs / user_ads.region_slugs / subscriptions.region_slugs (text[] not null
--     default '{}'). A row's region set = the regions of its cities (cities.region_slug) ∪ any region
--     named in the text/hint (lib/korea/cities/detect.ts detectRegionSlugs) ∪ the singular AI region
--     pick (region_slug). It is the region-level twin of city_ids (draft_0020): lets a user filter by
--     province, and lets a city-less "только область известна" offer still surface under a region.
--   * kj_geo_match(sel_cities, det_cities, sel_regions, det_regions, u) — the SINGLE immutable predicate
--     shared by the feed and the digest (supersedes kj_city_match there). Semantics (owner contract):
--       nothing selected (sel_cities AND sel_regions empty)      -> true   (no geo filter -> show all)
--       cardinality(det_cities)>0 and (sel_cities && det_cities)  -> true   (city overlap)
--       cardinality(det_regions)>0 and (sel_regions && det_regions) -> true (region overlap)
--       cardinality(det_cities)=0 and u                           -> true   (city-less bucket, "show it")
--       else                                                      -> false
--     NOTE the "no city" bucket is decided ONLY by det_cities — a region label never pulls an offer OUT
--     of the city-less bucket (owner rule). kj_city_match (draft_0020) is left in place for compatibility.
--
-- PART B — conditional AI-geo learning (owner rule: the model resolves a place ONLY when our dictionary
--   found NO city and NO region). geo_suggestions is a tiny owner-facing learning ledger:
--     * kind='city'  : a city_norm/region_norm the model returned that our full matcher could NOT resolve
--                      (surface = the model's normal name, norm='') — a candidate new alias/city.
--     * kind='slang' : a {slang -> norm} pair the model decoded (surface=slang as written, norm=decoded)
--                      — a candidate slang alias. Read only by admin /stats (top-5). Written best-effort.
--
-- content_hash / kj_content_hash / city_id / city_ids are NOT touched by ANY statement here.
--
-- DRAFT — DO NOT APPLY; the internal side applies it (apply.mjs, appended to the end of the list).

-- ── PART A: columns (additive, guarded) ───────────────────────────────────────────────────────────
alter table vacancies     add column if not exists region_slugs text[] not null default '{}';
alter table user_ads      add column if not exists region_slugs text[] not null default '{}';
alter table subscriptions add column if not exists region_slugs text[] not null default '{}';

comment on column vacancies.region_slugs is 'All regions this offer covers = regions of its city_ids (cities.region_slug) ∪ regions named in the text/hint ∪ the singular region_slug. Filled by the parser/backfill.';
comment on column user_ads.region_slugs is 'All regions this ad covers = region of its form city ∪ regions named in the description ∪ region_slug.';
comment on column subscriptions.region_slugs is 'Persistent region (province) filter; empty = no region filter. OR-combined with the city filter via kj_geo_match.';

-- ── PART A: guarded seed of region_slugs so the filter works the moment the column ships ───────────
-- region_slugs = distinct( regions of the row's cities ∪ the singular region_slug ), ONLY where the
-- array is still empty AND the row actually has a geo source. The exists()/is-not-null guard keeps this
-- idempotent (a re-apply finds the array already populated -> skipped) AND non-destructive (a row later
-- enriched by the parser / db/backfill_city_ids.mts only grows, never resets). city_id/city_ids untouched.
-- Built with the SAME correlated-scalar-subquery + unnest(concat) dedup pattern the parser already
-- uses for city_ids (proven in prod): the regions of the row's cities (a correlated array_agg) are
-- concatenated with the singular region_slug, then distinct-aggregated. No LATERAL needed — the only
-- outer reference is the UPDATE target row (v/a), never a sibling FROM item.
update vacancies v
set region_slugs = (
  select coalesce(array_agg(distinct e), '{}'::text[])
  from unnest(
    coalesce((select array_agg(c.region_slug) from cities c
              where c.id = any(v.city_ids) and c.region_slug is not null), '{}'::text[])
    || case when v.region_slug is not null then array[v.region_slug]::text[] else '{}'::text[] end
  ) as e
)
where cardinality(v.region_slugs) = 0
  and (
    exists (select 1 from cities c where c.id = any(v.city_ids) and c.region_slug is not null)
    or v.region_slug is not null
  );

update user_ads a
set region_slugs = (
  select coalesce(array_agg(distinct e), '{}'::text[])
  from unnest(
    coalesce((select array_agg(c.region_slug) from cities c
              where c.id = any(a.city_ids) and c.region_slug is not null), '{}'::text[])
    || case when a.region_slug is not null then array[a.region_slug]::text[] else '{}'::text[] end
  ) as e
)
where cardinality(a.region_slugs) = 0
  and (
    exists (select 1 from cities c where c.id = any(a.city_ids) and c.region_slug is not null)
    or a.region_slug is not null
  );

-- ── PART A: partial GIN indexes over the live working sets (mirror the city_ids indexes) ───────────
create index if not exists idx_vacancies_region_slugs
  on vacancies using gin (region_slugs)
  where is_active and duplicate_of is null;
create index if not exists idx_user_ads_region_slugs
  on user_ads using gin (region_slugs)
  where status = 'approved';
-- subscriptions is a single row per user; mirror the existing non-partial idx_subscriptions_city_ids.
create index if not exists idx_subscriptions_region_slugs
  on subscriptions using gin (region_slugs);

-- ── PART A: shared city+region match predicate (immutable -> index/expr-safe; drift-proof) ─────────
-- Args only, no subqueries. Coalesce guards keep it total even if a NULL array is ever passed (the
-- columns are NOT NULL, so on the hot path these are no-ops). See the header for the truth table.
create or replace function kj_geo_match(
  sel_cities uuid[], det_cities uuid[],
  sel_regions text[], det_regions text[],
  u boolean
) returns boolean
language sql
immutable
as $$
  select case
    when cardinality(coalesce(sel_cities, '{}'::uuid[])) = 0
      and cardinality(coalesce(sel_regions, '{}'::text[])) = 0 then true
    else (
      (cardinality(coalesce(det_cities, '{}'::uuid[])) > 0
        and (coalesce(sel_cities, '{}'::uuid[]) && coalesce(det_cities, '{}'::uuid[])))
      or (cardinality(coalesce(det_regions, '{}'::text[])) > 0
        and (coalesce(sel_regions, '{}'::text[]) && coalesce(det_regions, '{}'::text[])))
      or (cardinality(coalesce(det_cities, '{}'::uuid[])) = 0 and coalesce(u, true))
    )
  end;
$$;

comment on function kj_geo_match(uuid[], uuid[], text[], text[], boolean) is
  'Shared geo filter (sel_cities, det_cities, sel_regions, det_regions, show-city-less): empty city+region selection -> all; else city overlap OR region overlap OR (city-less AND show-city-less). The city-less bucket is decided ONLY by det_cities.';

-- ── PART B: conditional AI-geo learning ledger ────────────────────────────────────────────────────
-- Tiny, owner-inspection-only (admin /stats top-5). norm is NOT NULL default '' so a plain
-- unique(kind, surface, norm) enforces the intended unique(kind, surface, coalesce(norm,'')) correctly
-- for the null-norm ('city') case. Written best-effort by lib/korea/parser/run.ts (never blocks a parse).
create table if not exists geo_suggestions (
  id        uuid primary key default gen_random_uuid(),
  kind      text not null check (kind in ('city', 'slang')),
  surface   text not null,
  norm      text not null default '',
  n         int  not null default 0,
  last_seen timestamptz not null default now(),
  unique (kind, surface, norm)
);
comment on table geo_suggestions is 'AI-geo learning ledger (owner-only). kind=city: an unresolved model city/region name (norm=''); kind=slang: a decoded {slang surface -> norm}. n=hits, last_seen=latest. Read by admin /stats.';
create index if not exists idx_geo_suggestions_top on geo_suggestions (kind, n desc, last_seen desc);
