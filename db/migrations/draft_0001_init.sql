-- draft_0001_init.sql
-- korea-jobs — initial schema: extensions, enums, helpers, and all tables
-- (sources, cities, users, raw_messages, vacancies, subscriptions,
--  notifications_sent, config).
--
-- DRAFT ONLY. Do NOT apply automatically (rule #4). Apply order (Neon):
--   0001 -> seed -> sources_seed. (0002_rls is Supabase-only — NOT applied on Neon.)
--   See db/README.md.
--
-- Conventions (mirroring nhatrang):
--   * Localized text columns are jsonb shaped { "ru", "ko", "en" }.
--   * Timestamps are timestamptz, default now(); updated_at kept by trigger.
--   * Enums are created idempotently via a guarded DO block.
--   * content_hash is a generated column so the collector, the parser and the
--     DB never disagree on the dedup key.

-- ─────────────────────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────────────────────

-- pgcrypto: gen_random_uuid() for pk + gen_random_bytes() for users.public_id.
create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums (guarded so re-running does not error)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_type where typname = 'source_type') then
    create type source_type as enum ('channel', 'group', 'supergroup', 'private', 'unknown');
  end if;

  if not exists (select 1 from pg_type where typname = 'work_type') then
    create type work_type as enum (
      'factory',      -- завод / производство / сборка
      'construction', -- стройка
      'agriculture',  -- поле / сельхоз / ферма / теплица
      'fishery',      -- рыбзавод / море / морепродукты
      'food',         -- пищевое производство
      'logistics',    -- склад / сортировка / доставка
      'restaurant',   -- общепит / кухня / посудомойка
      'cleaning',     -- уборка / клининг
      'caregiving',   -- уход / сиделка
      'hotel',        -- отель / гостиница
      'services',     -- прочие услуги
      'other'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'gender') then
    create type gender as enum ('any', 'male', 'female', 'couple');
  end if;

  if not exists (select 1 from pg_type where typname = 'salary_period') then
    create type salary_period as enum ('hour', 'day', 'shift', 'month', 'piece');
  end if;

  if not exists (select 1 from pg_type where typname = 'contact_kind') then
    create type contact_kind as enum ('phone', 'telegram', 'kakao', 'whatsapp', 'other');
  end if;

  if not exists (select 1 from pg_type where typname = 'raw_status') then
    create type raw_status as enum ('pending', 'parsed', 'skipped', 'error');
  end if;

  if not exists (select 1 from pg_type where typname = 'delivery_status') then
    create type delivery_status as enum ('sent', 'failed', 'skipped');
  end if;

  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type user_role as enum ('user', 'admin');
  end if;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Shared trigger: keep updated_at in sync on UPDATE
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Dedup helpers (IMMUTABLE so they can drive generated columns).
-- kj_normalize_phone: collapse a Korean phone to digits in "82..." form.
--   +82-10-1234-5678 / 010-1234-5678 / 010 1234 5678  ->  821012345678
-- kj_normalize_contact: phone-like input -> normalized phone; otherwise a
--   lowercased handle/id (@user, kakao id) with '@' and spaces stripped.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function kj_normalize_phone(raw text)
returns text
language sql
immutable
as $$
  with d as (
    select regexp_replace(coalesce(raw, ''), '[^0-9]', '', 'g') as digits
  )
  select case
    when digits = ''             then null
    when length(digits) < 9      then null                    -- too short to be real
    when length(digits) > 13     then null                    -- too long -> not a phone
    when left(digits, 2) = '82'  then digits                  -- already country-coded
    when left(digits, 1) = '0'   then '82' || substr(digits, 2) -- local 010.. -> 8210..
    else digits
  end
  from d;
$$;

create or replace function kj_normalize_contact(raw text)
returns text
language sql
immutable
as $$
  select case
    when raw is null or btrim(raw) = '' then null
    when length(regexp_replace(raw, '[^0-9]', '', 'g')) >= 9
      then kj_normalize_phone(raw)
    else nullif(lower(btrim(regexp_replace(replace(raw, '@', ''), '\s+', '', 'g'))), '')
  end;
$$;

comment on function kj_normalize_phone(text)  is 'Korean phone -> digits in 82... form; NULL when not phone-like.';
comment on function kj_normalize_contact(text) is 'Phone-like -> normalized phone; else lowercased handle/id; NULL when empty.';

-- enum -> text is catalog-dependent (labels can be renamed), so Postgres treats a
-- bare `col::text` as STABLE and refuses it in a generated column
-- ("generation expression is not immutable"). These wrappers are language plpgsql
-- ON PURPOSE: a `language sql` wrapper would be inlined and the check would see the
-- enum cast through it; plpgsql is opaque to the planner, so the IMMUTABLE label is
-- honored. Safe here — our enum labels are never renamed, and the wrapper returns
-- the exact same label text a plain cast would.
create or replace function kj_work_type_text(work_type)
returns text language plpgsql immutable as $$ begin return $1::text; end; $$;

create or replace function kj_gender_text(gender)
returns text language plpgsql immutable as $$ begin return $1::text; end; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- config — feature flags / tunables (mirrors cargobob cb_config).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table config is 'Server-side flags/tunables (vacancy TTL, parser model/batch, notify switch). Written by service role only.';

drop trigger if exists trg_config_updated_at on config;
create trigger trg_config_updated_at
  before update on config
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- sources — Telegram chats/channels the reader (userbot) sits in.
-- tg_chat_id is unique but nullable (a source may be added by username before
-- its peer id is resolved; Postgres allows multiple NULLs in a unique index).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists sources (
  id              uuid primary key default gen_random_uuid(),
  tg_chat_id      bigint unique,
  username        text,
  title           text,
  type            source_type not null default 'unknown',
  is_active       boolean not null default true,
  joined_at       timestamptz,
  last_message_at timestamptz,
  added_by        text,                        -- free note: 'owner' / 'susanin' etc.
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table sources is 'Telegram chats/channels read by the userbot collector. Approved by the owner before the reader joins.';

create index if not exists idx_sources_active on sources (is_active);

drop trigger if exists trg_sources_updated_at on sources;
create trigger trg_sources_updated_at
  before update on sources
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- cities — canonical Korean cities + spelling variants for normalization.
-- name    : jsonb { ru, ko, en } canonical display names.
-- aliases : jsonb ARRAY of lowercased spellings (ru/ko/en/translit) used to
--           help the parser/normalizer map free text to a canonical city.
-- region_slug: province/metro slug (seoul, gyeonggi, busan, ...).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists cities (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,           -- 'seoul', 'ansan', ...
  name        jsonb not null,                 -- { ru, ko, en }
  aliases     jsonb not null default '[]',    -- ["сеул","서울","seoul","seul"]
  region_slug text,
  lat         double precision,
  lng         double precision,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table cities is 'Canonical Korean cities; aliases jsonb array feeds text->city normalization for the parser.';
comment on column cities.aliases is 'jsonb array of lowercased alt spellings (ru/ko/en/translit).';

create index if not exists idx_cities_active   on cities (is_active);
create index if not exists idx_cities_region   on cities (region_slug);
create index if not exists idx_cities_aliases  on cities using gin (aliases);

drop trigger if exists trg_cities_updated_at on cities;
create trigger trg_cities_updated_at
  before update on cities
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- users — one row per Telegram user. telegram_id NEVER leaves the backend;
-- public_id is the opaque outward id. Upserted by the auth path after initData
-- validation (reused nhatrang/cargobob pattern; stateless, not GoTrue).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists users (
  id                 uuid primary key default gen_random_uuid(),
  telegram_id        bigint not null unique,
  public_id          text   not null unique default encode(gen_random_bytes(8), 'hex'),
  username           text,
  first_name         text,
  last_name          text,
  lang               text not null default 'ru',
  role               user_role not null default 'user',
  allows_write_to_pm boolean not null default false,  -- gate for bot push (PLAN §4)
  is_blocked         boolean not null default false,   -- user blocked the bot
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_seen_at       timestamptz not null default now()
);

comment on table users is 'Telegram users; telegram_id is backend-only, public_id is the outward id.';
comment on column users.allows_write_to_pm is 'From initData; required before the bot may DM this user.';

create index if not exists idx_users_telegram_id on users (telegram_id);

drop trigger if exists trg_users_updated_at on users;
create trigger trg_users_updated_at
  before update on users
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- raw_messages — "inbox": every message the reader captures, raw.
-- Idempotency: UNIQUE (source_id, tg_message_id) so re-delivery / history
-- backfill / reader restarts never double-insert.
-- vacancy_id FK is added AFTER vacancies exists (see end of file) to avoid a
-- circular table dependency.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists raw_messages (
  id              uuid primary key default gen_random_uuid(),
  source_id       uuid not null references sources (id) on delete cascade,
  tg_message_id   bigint not null,
  tg_chat_id      bigint,
  sender_id       bigint,
  sender_username text,
  text            text,
  raw             jsonb,               -- trimmed payload (entities, media flags); NO media blobs
  posted_at       timestamptz,         -- message date from Telegram
  fetched_at      timestamptz not null default now(),
  status          raw_status not null default 'pending',
  processed_at    timestamptz,
  vacancy_id      uuid,                -- FK added below
  error           text,
  constraint uq_raw_source_msg unique (source_id, tg_message_id)
);

comment on table raw_messages is 'Raw captured Telegram messages; UNIQUE(source_id, tg_message_id) gives collector idempotency.';

create index if not exists idx_raw_pending on raw_messages (fetched_at) where status = 'pending';
create index if not exists idx_raw_source  on raw_messages (source_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- vacancies — parsed, normalized, de-duplicated offers.
-- content_hash (generated): dedup key = normalized contact + city + work_type +
--   gender (+ optional dedup_extra). One ACTIVE canonical per hash is enforced
--   by a partial unique index below; reposts are linked via duplicate_of.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists vacancies (
  id                 uuid primary key default gen_random_uuid(),
  -- classification / location
  city_id            uuid references cities (id) on delete set null,
  region_slug        text,                          -- when only a region is known
  work_type          work_type not null default 'other',
  gender             gender    not null default 'any',
  lang               text,                          -- ISO 639-1 detected by parser
  -- content
  title              text,
  description        text,
  employer           text,
  -- salary
  salary_text        text,                          -- raw as written
  salary_min         integer,
  salary_max         integer,
  salary_currency    text not null default 'KRW',
  salary_period      salary_period,
  -- contact (raw kept; normalized copy for dedup + lookups)
  contact_raw        text,
  contact_kind       contact_kind,
  contact_normalized text generated always as (kj_normalize_contact(contact_raw)) stored,
  -- provenance
  source_id          uuid references sources (id)      on delete set null,
  raw_message_id     uuid references raw_messages (id) on delete set null,
  posted_at          timestamptz not null default now(),
  -- dedup
  dedup_extra        text,                           -- parser-supplied core when no contact
  -- digest(text,'sha256') from pgcrypto, NOT sha256(convert_to(...,'UTF8')):
  -- convert_to is STABLE (encoding-dependent) and cannot drive a generated column,
  -- whereas pgcrypto's digest is IMMUTABLE. On a UTF8 database the bytes hashed are
  -- identical, so the hash value is unchanged.
  content_hash       text generated always as (
    encode(digest(
      coalesce(kj_normalize_contact(contact_raw), 'nocontact') || '|' ||
      coalesce(city_id::text, 'nocity')                        || '|' ||
      coalesce(kj_work_type_text(work_type), 'nowork')         || '|' ||
      coalesce(kj_gender_text(gender), 'any')                  || '|' ||
      coalesce(nullif(btrim(dedup_extra), ''), '')
    , 'sha256'), 'hex')
  ) stored,
  duplicate_of       uuid references vacancies (id) on delete set null,
  repost_count       integer not null default 0,
  -- lifecycle
  is_active          boolean not null default true,
  notify_pending     boolean not null default true,   -- true until the notify cron has handled it (Sanya §4.1)
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table vacancies is 'Parsed, normalized, de-duplicated job offers. Sensitive (employer contacts) -> no anon access.';
comment on column vacancies.content_hash is 'Generated dedup key: normalized contact + city + work_type + gender + dedup_extra.';
comment on column vacancies.duplicate_of is 'Set on a repost row; points to the canonical active vacancy.';

-- One active canonical per content_hash (drives the dedup upsert; see §b).
create unique index if not exists uniq_vacancies_active_hash
  on vacancies (content_hash) where is_active and duplicate_of is null;

-- Feed filters: by city + freshness, by city + work_type + freshness, global freshness.
create index if not exists idx_vacancies_city_fresh
  on vacancies (city_id, posted_at desc) where is_active and duplicate_of is null;
create index if not exists idx_vacancies_city_worktype
  on vacancies (city_id, work_type, posted_at desc) where is_active and duplicate_of is null;
create index if not exists idx_vacancies_fresh
  on vacancies (posted_at desc) where is_active and duplicate_of is null;

-- Notify cron scans only unprocessed canonical vacancies, oldest first (Sanya §4.1).
-- The notification window is measured by first_seen_at (NOT posted_at) so a history
-- backfill on first join does not push stale offers to users (Sanya §4.2).
create index if not exists idx_vacancies_notify_pending
  on vacancies (first_seen_at) where notify_pending and is_active and duplicate_of is null;

create index if not exists idx_vacancies_source        on vacancies (source_id);
create index if not exists idx_vacancies_raw_message   on vacancies (raw_message_id);
create index if not exists idx_vacancies_duplicate_of  on vacancies (duplicate_of);
create index if not exists idx_vacancies_contact_norm  on vacancies (contact_normalized);

drop trigger if exists trg_vacancies_updated_at on vacancies;
create trigger trg_vacancies_updated_at
  before update on vacancies
  for each row execute function set_updated_at();

-- Deferred FK: raw_messages.vacancy_id -> vacancies.id (breaks the cycle).
alter table raw_messages
  drop constraint if exists fk_raw_vacancy;
alter table raw_messages
  add constraint fk_raw_vacancy
  foreign key (vacancy_id) references vacancies (id) on delete set null;

-- ─────────────────────────────────────────────────────────────────────────────
-- subscriptions — one row per user: chosen cities + optional work_types + push.
-- Single-row-per-user (unique user_id) = "my filter + notify toggle".
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references users (id) on delete cascade,
  city_ids    uuid[]  not null default '{}',
  work_types  work_type[],                    -- NULL/empty = all types
  notify      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table subscriptions is 'Per-user filter (city_ids, optional work_types) and push toggle.';

-- GIN over city_ids: fast "which subscribers want this vacancy's city".
create index if not exists idx_subscriptions_city_ids on subscriptions using gin (city_ids);
create index if not exists idx_subscriptions_notify    on subscriptions (notify) where notify;

drop trigger if exists trg_subscriptions_updated_at on subscriptions;
create trigger trg_subscriptions_updated_at
  before update on subscriptions
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- notifications_sent — push dedup. UNIQUE (user_id, vacancy_id): a user is
-- notified about a given vacancy at most once.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists notifications_sent (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id)     on delete cascade,
  vacancy_id    uuid not null references vacancies (id) on delete cascade,
  status        delivery_status not null default 'sent',
  tg_message_id bigint,
  error         text,
  sent_at       timestamptz not null default now(),
  constraint uq_notif_user_vac unique (user_id, vacancy_id)
);

comment on table notifications_sent is 'One row per (user, vacancy) push; UNIQUE prevents double-notify.';

create index if not exists idx_notif_vacancy on notifications_sent (vacancy_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- bot_updates — webhook idempotency ledger. update_id (PK) dedups Telegram
-- retries (it replays the same update on any non-2xx); also drives a durable
-- per-sender rate limit (cargobob webhook pattern).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists bot_updates (
  update_id   bigint primary key,
  from_id     bigint,
  received_at timestamptz not null default now()
);

comment on table bot_updates is 'Telegram webhook dedup ledger + per-sender rate-limit source.';

create index if not exists idx_bot_updates_from on bot_updates (from_id, received_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- contact_reveals — audit + per-user daily cap on employer-contact reveals
-- (007 anti-harvesting). UNIQUE (user_id, vacancy_id): a repeat reveal of the same
-- vacancy is free and not re-counted. Records the FACT of a reveal, never the value.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists contact_reveals (
  user_id     uuid not null references users (id)     on delete cascade,
  vacancy_id  uuid not null references vacancies (id) on delete cascade,
  revealed_at timestamptz not null default now(),
  primary key (user_id, vacancy_id)
);

comment on table contact_reveals is 'Per (user, vacancy) contact reveal; drives the daily cap. Value is never stored.';

create index if not exists idx_contact_reveals_daily on contact_reveals (user_id, revealed_at);
