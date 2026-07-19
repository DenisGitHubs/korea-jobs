-- draft_0012_my_ads.sql
-- korea-jobs — "Мои объявления": an author can bump / edit / archive / unarchive / delete an
-- ad they placed through the mini app. ADDITIVE ONLY. Guarded + idempotent (re-runnable).
-- DRAFT — DO NOT APPLY; the internal side applies it. Depends on user_ads (draft_0003_user_ads.sql).
--
-- Two schema touches + two config tunables:
--   1. user_ad_status gains the label 'archived' — an author-hidden ad. It never reaches the
--      feed (the feed filters status='approved'), and archive/unarchive move rows in/out of it.
--   2. user_ads.bumped_at — when the author last "bumped" the ad. The feed sorts a user ad by
--      greatest(created_at, bumped_at), so a bump floats it back to the top (see feedUnionSql /
--      savedUnionSql in lib/korea/vacancies/read.ts). NULL until the first bump.
--
-- ⚠ POSTGRES TRANSACTION RULE (same as draft_0005_visa_types.sql): `ALTER TYPE ... ADD VALUE`
--   may NOT be used in the SAME transaction that later USES the new label. This file NEVER uses
--   'archived' (only the column add + config seeds follow), so it is safe as one unit — the
--   db/apply.mjs runner sends each file as its own committed query. `IF NOT EXISTS` /
--   `ON CONFLICT DO NOTHING` make every statement idempotent.

alter type user_ad_status add value if not exists 'archived';

alter table user_ads
  add column if not exists bumped_at timestamptz;

comment on column user_ads.bumped_at is
  'When the author last bumped this ad. The feed orders a user ad by greatest(created_at, bumped_at), so a bump refloats it. NULL until first bump.';

-- Config for "Мои объявления" (idempotent; tune without a deploy). The handlers already fall
-- back to these defaults via getConfigNumber, so seeding is optional but keeps them discoverable.
insert into config (key, value) values
  ('user_ad_bump_min_hours',   '12'),  -- min hours between bumps of the same ad (else 429)
  ('user_ad_edit_min_minutes', '10')   -- min minutes between edits of the same ad (else 429)
on conflict (key) do nothing;
