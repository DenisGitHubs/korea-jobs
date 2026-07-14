-- draft_0002_rls.sql
-- Row Level Security for korea-jobs.
--
-- ⚠ SUPABASE-ONLY — DO NOT APPLY ON NEON (007, 2026-07-13).
-- This RLS protected the Supabase PostgREST anon surface. On Neon there is no
-- anon/PostgREST surface, so it protects nothing; worse, if applied it either
-- no-ops (the table-owner role bypasses RLS) or LOCKS THE APP OUT (forced deny-all
-- with no matching policies). Its GUC/JWT approach also cannot work over Neon's
-- stateless HTTP driver (set_config does not survive between requests).
-- Kept for reference only. On Neon, security lives in the serverless layer
-- (parameterized queries, projection, initData checks, user-scoping in code).
-- See db/README.md.
--
-- ── Access model (review this) ───────────────────────────────────────────────
-- Stateless initData validation (reused from nhatrang/cargobob), NOT GoTrue.
--
--   * vacancies / raw_messages / sources / notifications_sent / config:
--     NO anonymous access. All reads go through Vercel serverless functions
--     that validate initData in code and query with the SERVICE ROLE (which
--     bypasses RLS). Rationale: vacancies embed scraped EMPLOYER CONTACTS
--     (third-party PII) — an open anon PostgREST endpoint would be a harvester.
--     Only admin read policies exist here, for an internal panel.
--
--   * cities: public read of active rows (non-sensitive reference list needed
--     by the filter screen). Writes are admin/service only. If 007 prefers a
--     fully closed surface, drop cities_read_active and serve cities via the API.
--
--   * users / subscriptions: self policies (defense in depth) via
--     app.current_user_id() when strategy (B) GUC is used; service role
--     otherwise. Admin reads all.
--
-- app.current_user_id() reads the user uuid from a JWT claim (app_user_id) or a
-- session GUC (app.current_user_id); NULL when unauthenticated -> deny.

create schema if not exists app;

create or replace function app.current_user_id()
returns uuid
language plpgsql
stable
as $$
declare
  claims_txt text;
  claim_val  text;
  guc_val    text;
begin
  begin
    claims_txt := current_setting('request.jwt.claims', true);
  exception when others then
    claims_txt := null;
  end;

  if claims_txt is not null and claims_txt <> '' then
    claim_val := (claims_txt::jsonb) ->> 'app_user_id';
    if claim_val is not null and claim_val <> '' then
      return claim_val::uuid;
    end if;
  end if;

  begin
    guc_val := current_setting('app.current_user_id', true);
  exception when others then
    guc_val := null;
  end;

  if guc_val is not null and guc_val <> '' then
    return guc_val::uuid;
  end if;

  return null;
end;
$$;

comment on function app.current_user_id() is
  'Current app user uuid from JWT claim app_user_id or GUC app.current_user_id; NULL if unauthenticated.';

create or replace function app.is_admin()
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from users u
    where u.id = app.current_user_id()
      and u.role = 'admin'
  );
$$;

comment on function app.is_admin() is 'True when the current app user has role = admin.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Enable RLS everywhere (deny-by-default until a policy allows).
-- ─────────────────────────────────────────────────────────────────────────────

alter table config             enable row level security;
alter table sources            enable row level security;
alter table cities             enable row level security;
alter table users              enable row level security;
alter table raw_messages       enable row level security;
alter table vacancies          enable row level security;
alter table subscriptions      enable row level security;
alter table notifications_sent enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- cities: public read of active rows; writes admin-only. (Only public surface.)
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists cities_read_active on cities;
create policy cities_read_active on cities
  for select
  using (is_active or app.is_admin());

drop policy if exists cities_admin_write on cities;
create policy cities_admin_write on cities
  for all
  using (app.is_admin())
  with check (app.is_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- users: self read/insert/update; admin reads all. Inserts happen via the
-- auth path (service role); self policies allow a correctly-scoped upsert too.
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists users_self_read on users;
create policy users_self_read on users
  for select
  using (id = app.current_user_id() or app.is_admin());

drop policy if exists users_self_insert on users;
create policy users_self_insert on users
  for insert
  with check (id = app.current_user_id());

drop policy if exists users_self_update on users;
create policy users_self_update on users
  for update
  using (id = app.current_user_id())
  with check (id = app.current_user_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- subscriptions: a user reads/writes only their own row; admin reads all.
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists subs_self_read on subscriptions;
create policy subs_self_read on subscriptions
  for select
  using (user_id = app.current_user_id() or app.is_admin());

drop policy if exists subs_self_write on subscriptions;
create policy subs_self_write on subscriptions
  for all
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- vacancies / raw_messages / sources / notifications_sent / config:
-- CLOSED. No anon/self policies -> RLS denies all PostgREST access. The service
-- role (serverless functions) bypasses RLS. Admin read-only for an internal panel.
-- No write policies: writes are service-role only.
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists vacancies_admin_read on vacancies;
create policy vacancies_admin_read on vacancies
  for select using (app.is_admin());

drop policy if exists raw_messages_admin_read on raw_messages;
create policy raw_messages_admin_read on raw_messages
  for select using (app.is_admin());

drop policy if exists sources_admin_read on sources;
create policy sources_admin_read on sources
  for select using (app.is_admin());

drop policy if exists notifications_admin_read on notifications_sent;
create policy notifications_admin_read on notifications_sent
  for select using (app.is_admin());

drop policy if exists config_admin_read on config;
create policy config_admin_read on config
  for select using (app.is_admin());
