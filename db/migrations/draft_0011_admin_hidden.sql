-- draft_0011_admin_hidden.sql
-- korea-jobs — mark vacancies the admin manually HID from a report (bot callback rep:hide) so a
-- later repost cannot resurrect them against the owner's decision.
--
-- Background: rep:hide sets is_active=false (a reversible hide, never a delete). Separately, the
-- parser's repost logic revives an is_active=false canonical on a fresh sighting (owner rule
-- 2026-07-19: "reposted today → still relevant → lift it back up"). Those two collide: a repost of
-- a report-hidden vacancy would silently un-hide it. admin_hidden records the human decision so the
-- parser can tell an ADMIN hide (must stay hidden) apart from a TTL/auto expiry (fine to revive).
--   * true  — hidden by the admin via rep:hide; the parser must NEVER revive or lift it, and must
--              NOT insert a fresh copy of the same content_hash (see the parser admin-hidden gate).
--   * false — default; ordinary active/auto-expired vacancy, revived on repost as usual.
--
-- ADDITIVE ONLY. Guarded (ADD COLUMN IF NOT EXISTS). DRAFT — DO NOT APPLY; the internal side
-- applies it. Depends on: vacancies (draft_0001_init.sql).

alter table vacancies
  add column if not exists admin_hidden boolean not null default false;

-- Partial index for the parser's admin-hidden gate: it probes vacancies by content_hash among
-- admin_hidden rows on EVERY accepted candidate. The only other content_hash index is the partial
-- unique over (is_active and duplicate_of is null), which can never cover admin_hidden=true rows
-- (they are inactive) — without this index the gate would seq-scan vacancies (Цензор, gate 19.07).
create index if not exists idx_vacancies_admin_hidden_hash
  on vacancies (content_hash) where admin_hidden;

comment on column vacancies.admin_hidden is
  'true when the admin hid this vacancy via a report (bot rep:hide). The parser never revives/lifts an admin_hidden canonical and refuses to insert a fresh copy of the same content_hash, so the owner''s hide is not overridden by a later repost. Set alongside is_active=false in the rep:hide handler.';
