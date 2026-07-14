-- draft_0003_takedown.sql
-- korea-jobs — Phase 1 v2: takedowns + user vacancy reports. ADDITIVE ONLY.
--
-- takedowns (007 CRITICAL — Bot Developer ToS 5.2(i): publishing a third party''s
-- contact without consent is prohibited). A takedown deactivates the offending
-- vacancy AND records its content_hash so a repost with the SAME dedup key is never
-- resurrected: the parser pre-checks this table before inserting, and cleanup enforces
-- it on any active row that slipped through.
--
-- vacancy_reports: a user flags a vacancy; UNIQUE(user_id, vacancy_id) so one user
-- reports a given vacancy at most once (drives a per-user daily cap in the API).

create table if not exists takedowns (
  id             uuid primary key default gen_random_uuid(),
  content_hash   text not null,
  contact_normalized text,
  source_id      uuid references sources (id)      on delete set null,
  raw_message_id uuid references raw_messages (id) on delete set null,
  reason         text,
  created_at     timestamptz not null default now()
);

comment on table takedowns is 'Content taken down (ToS 5.2(i)); content_hash blocks re-insert of the same dedup key.';

create index if not exists idx_takedowns_content_hash on takedowns (content_hash);

create table if not exists vacancy_reports (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id)     on delete cascade,
  vacancy_id uuid not null references vacancies (id) on delete cascade,
  reason     text,
  created_at timestamptz not null default now(),
  constraint uq_vacancy_reports_user_vac unique (user_id, vacancy_id)
);

comment on table vacancy_reports is 'User-submitted reports on a vacancy; UNIQUE(user, vacancy) = at most one per user.';

create index if not exists idx_vacancy_reports_vacancy on vacancy_reports (vacancy_id);
create index if not exists idx_vacancy_reports_daily   on vacancy_reports (user_id, created_at);
