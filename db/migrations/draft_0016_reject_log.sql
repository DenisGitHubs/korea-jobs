-- draft_0016_reject_log.sql
-- korea-jobs — AI reject journal (owner rule 2026-07-20). Two INTERNAL tables that let the owner
-- look at WHAT the AI throws away. NO API/bot surface reads them; the parser writes them best-effort
-- (lib/korea/parser/reject-log.ts swallows + logs on failure), so a failed write never breaks a parse.
--
--   * ai_reject_stats   — a per-day, per-reason COUNTER. Tiny and permanent (never purged by cleanup).
--   * ai_reject_samples — the FULL original text of a rejected message, kept ONLY while the owner has
--                         flipped config 'reject_log_enabled' on. cleanup/run.ts purges rows > 7 days.
--
-- Scope of what lands here (lib/korea/parser/run.ts): AI-VERDICT rejects only — not_vacancy / chitchat
-- / resume_seeking_job / agency_promo / course_ad / housing / currency_exchange / spam / unclear /
-- ad_non_job. It EXCLUDES 'low_confidence' (that is the visible "Не проверено" tab, not a discard) and
-- 'spam_prefilter' (dropped before the AI is ever called, so it never reaches this path).
--
-- ai_reject_samples.text stores the FULL raw message (third-party text, may include a phone number) —
-- that is why it is INTERNAL-only and time-boxed to 7 days by the cleanup cron; it is a temporary
-- inspection buffer, not a corpus. source_note is a cheap label (the source channel's @username, taken
-- from the join the parser already does), NULL when the source has no username.
--
-- ADDITIVE ONLY. Guarded (IF NOT EXISTS). DRAFT — DO NOT APPLY; the internal side applies it.
-- Depends on: pgcrypto (gen_random_uuid, draft_0001_init.sql). Apply order: ... 0015 -> 0016.

create table if not exists ai_reject_samples (
  id            uuid primary key default gen_random_uuid(),
  rejected_at   timestamptz not null default now(),
  reject_reason text not null,
  confidence    real,
  posted_at     timestamptz,
  text          text not null,
  source_note   text
);

comment on table ai_reject_samples is
  'INTERNAL reject inspection buffer: FULL original text of AI-discarded messages, written only while config reject_log_enabled is on and purged > 7 days by cleanup. No API reads it. Additive.';

-- The only read is "recent rejects, optionally by reason", so index rejected_at.
create index if not exists idx_ai_reject_samples_rejected_at on ai_reject_samples (rejected_at);

create table if not exists ai_reject_stats (
  day    date not null,
  reason text not null,
  n      int  not null default 0,
  primary key (day, reason)
);

comment on table ai_reject_stats is
  'INTERNAL per-day, per-reason counter of AI-verdict rejects (excludes low_confidence / spam_prefilter). Tiny; NOT purged. Additive.';
