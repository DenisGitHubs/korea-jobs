-- draft_0008_raw_reveal.sql
-- korea-jobs — reveal the ORIGINAL text of an UNVERIFIED raw message (POST /api/raw/reveal).
--
-- Adds the audit table that (a) records each raw reveal and (b) feeds the SHARED per-user
-- daily reveal cap alongside contact_reveals (vacancies) + ad_contact_reveals (user ads).
-- The API (reveals24h) counts all THREE tables against ONE 24h budget (contact_reveal_daily_cap).
--
-- ADDITIVE ONLY. Guarded (IF NOT EXISTS). No RLS — mirrors contact_reveals / ad_contact_reveals,
-- which have no row-level policies either (the Neon DB is closed by construction: all access is
-- the service-role serverless layer; there is no public/anon API — see lib/korea/core/db.ts).
--
-- DRAFT — DO NOT APPLY here; the internal side applies it. ORDERING: apply this BEFORE the
-- matching code goes live — reveals24h() is ALSO used by GET /api/vacancies/:id/contact, so the
-- code references raw_contact_reveals as soon as it deploys.
-- Depends on: users (draft_0001_init.sql), raw_messages (draft_0001_init.sql).

-- ─────────────────────────────────────────────────────────────────────────────
-- raw_contact_reveals — audit + shared daily cap for UNVERIFIED-message reveals.
-- Mirrors contact_reveals / ad_contact_reveals. UNIQUE (user_id, raw_id): a repeat reveal of
-- the same raw message is free and not re-counted. Records the FACT only, never the text.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists raw_contact_reveals (
  user_id     uuid not null references users (id)        on delete cascade,
  raw_id      uuid not null references raw_messages (id) on delete cascade,
  revealed_at timestamptz not null default now(),
  primary key (user_id, raw_id)
);

comment on table raw_contact_reveals is 'Per (user, raw_message) reveal of the ORIGINAL unverified text; shares the per-user daily cap with contact_reveals + ad_contact_reveals. Value is never stored.';

create index if not exists idx_raw_contact_reveals_daily on raw_contact_reveals (user_id, revealed_at);
