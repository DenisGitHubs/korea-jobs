-- draft_0003_subscription_filters.sql
-- korea-jobs — Phase 1 v2: persistent subscription filters mirroring the new vacancy
-- attributes. These drive BOTH the default feed and push notifications. ADDITIVE ONLY.
-- Depends on the visa_type / placement_fee enums from draft_0003_vacancy_fields.sql.
--
-- Region is filtered via cities.region_slug (no dedicated column here).
--
-- Matching is PERMISSIVE by design (empty/NULL always passes; only an EXPLICIT
-- contradiction is excluded) so rare attributes never empty the feed — see the API
-- feed filter and notify/run.ts for the exact predicates.
--   visa_types      : empty = no visa filter.
--   placement_fee   : NULL  = no fee filter.
--   require_housing : NULL/false = no housing filter; true = require has_housing (true or unstated).
--   require_meals   : NULL/false = no meals filter;   true = require has_meals   (true or unstated).

alter table subscriptions
  add column if not exists visa_types      visa_type[] not null default '{}',
  add column if not exists placement_fee   placement_fee,
  add column if not exists require_housing boolean,
  add column if not exists require_meals   boolean;

comment on column subscriptions.visa_types      is 'Persistent visa filter; empty = all.';
comment on column subscriptions.placement_fee   is 'Persistent fee filter; NULL = all (free/paid).';
comment on column subscriptions.require_housing is 'When true, keep only offers with housing (or unstated).';
comment on column subscriptions.require_meals   is 'When true, keep only offers with meals (or unstated).';
