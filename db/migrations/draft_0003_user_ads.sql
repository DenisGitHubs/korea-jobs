-- draft_0003_user_ads.sql
-- korea-jobs — Phase 1 v2: user-submitted job ads ("Разместить"), AI moderation
-- learning set, contact-reveal audit for ads, and the cooperation stub. ADDITIVE ONLY.
-- Depends on visa_type / placement_fee enums from draft_0003_vacancy_fields.sql.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enum
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_ad_status') then
    create type user_ad_status as enum ('draft', 'pending', 'approved', 'rejected', 'taken_down', 'expired');
  end if;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- user_ads — same STRUCTURAL fields as a vacancy (so the feed can UNION them) plus
-- author + moderation lifecycle + ad-only extras. Only status='approved' & not-expired
-- rows appear in the public feed (tagged source_kind='user').
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists user_ads (
  id             uuid primary key default gen_random_uuid(),
  author_user_id uuid references users (id) on delete set null,
  -- structural fields mirroring vacancies
  city_id        uuid references cities (id) on delete set null,
  region_slug    text,
  work_type      work_type     not null default 'other',
  visa_types     visa_type[]   not null default '{}',
  placement_fee  placement_fee not null default 'unknown',
  has_housing    boolean,
  has_meals      boolean,
  salary_text    text,
  title          text,
  description    text,
  contact_raw    text,
  contact_kind   contact_kind,
  -- ad-only extras
  housing_terms  text,
  meals_info     text,
  schedule       text,
  -- moderation lifecycle
  status         user_ad_status not null default 'pending',
  moderated_at   timestamptz,
  reject_reason  text,
  ai_confidence  real,
  -- lifecycle
  created_at     timestamptz not null default now(),
  expires_at     timestamptz,
  updated_at     timestamptz not null default now(),
  -- full-text (same 'simple' config as vacancies; feeds the unified q filter)
  search_tsv     tsvector generated always as (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))
  ) stored
);

comment on table user_ads is 'User-submitted job ads; approved+unexpired rows join the feed as source_kind=user.';

create index if not exists idx_user_ads_status_created on user_ads (status, created_at desc);
create index if not exists idx_user_ads_author         on user_ads (author_user_id);
create index if not exists idx_user_ads_feed           on user_ads (created_at desc) where status = 'approved';
create index if not exists idx_user_ads_search         on user_ads using gin (search_tsv);

drop trigger if exists trg_user_ads_updated_at on user_ads;
create trigger trg_user_ads_updated_at
  before update on user_ads
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- ad_contact_reveals — contact-reveal audit + daily cap for USER ADS. Separate table
-- (FK to user_ads) so it doesn't collide with contact_reveals (FK to vacancies); the
-- API counts BOTH tables against one per-user 24h cap (unified reveal budget).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists ad_contact_reveals (
  user_id     uuid not null references users (id)    on delete cascade,
  user_ad_id  uuid not null references user_ads (id) on delete cascade,
  revealed_at timestamptz not null default now(),
  primary key (user_id, user_ad_id)
);

comment on table ad_contact_reveals is 'Per (user, user_ad) contact reveal; shares the per-user daily cap with contact_reveals.';

create index if not exists idx_ad_contact_reveals_daily on ad_contact_reveals (user_id, revealed_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- moderation_examples — self-learning set for the ad classifier. Every human/API
-- moderation decision is recorded here; the classifier injects a balanced few-shot
-- sample (recent approved + rejected) into its prompt (config-gated).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists moderation_examples (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null default 'user_ad',
  text       text not null,
  decision   text not null,            -- 'approved' | 'rejected'
  reason     text,
  created_at timestamptz not null default now()
);

comment on table moderation_examples is 'Recorded moderation decisions; feeds the ad classifier few-shot (balanced recent sample).';

create index if not exists idx_moderation_examples_recent on moderation_examples (decision, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- cooperation_requests — "Сотрудничество" stub. We only persist the request for now
-- (no email is sent yet). ADDITIVE audit table.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists cooperation_requests (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references users (id) on delete set null,
  contact    text,
  message    text,
  created_at timestamptz not null default now()
);

comment on table cooperation_requests is 'Cooperation enquiries (stub); persisted for audit, no email sent yet.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Config for the ad pipeline (idempotent; tune without a deploy).
-- ─────────────────────────────────────────────────────────────────────────────

insert into config (key, value) values
  ('ads_auto_approve_min', '0.8'),   -- min confidence to auto-approve a user ad
  ('ads_fewshot_size',     '10'),    -- total balanced moderation examples in the classifier prompt
  ('ads_fewshot_enabled',  'true'),  -- toggle the few-shot learning preface
  ('user_ad_ttl_days',     '14'),    -- an approved ad expires after N days
  ('moderation_examples_retention_days', '180') -- purge learning examples older than N days (PII hygiene)
on conflict (key) do nothing;
