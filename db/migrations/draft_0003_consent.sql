-- draft_0003_consent.sql
-- korea-jobs — Phase 1 v2: terms-of-use consent, stored SERVER-SIDE on the user row.
-- (Susanin/007 brief: legally-meaningful consent must live on the server, not in
--  Telegram CloudStorage.) ADDITIVE ONLY.
--
--   terms_accepted_at : when the user accepted (NULL = never).
--   terms_version     : which version they accepted (compared against config terms_version).

alter table users
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version     text;

comment on column users.terms_accepted_at is 'When the user accepted the terms of use (NULL = not yet).';
comment on column users.terms_version     is 'Terms version the user accepted; re-consent required when config terms_version is newer.';

-- Current terms version (a date string). GET /api/me compares the user''s accepted
-- version against this to decide whether re-consent is required.
insert into config (key, value) values ('terms_version', '"2026-07-15"')
on conflict (key) do nothing;
