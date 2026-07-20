-- draft_0019_broadcast.sql
-- korea-jobs — admin broadcast tool (owner request 2026-07-21). ADDITIVE ONLY, guarded
-- (idempotent): a single new table, nothing on existing tables.
--
-- The owner sends /broadcast <text> to the bot in a private chat; the bot stores the text
-- as a DRAFT row here, shows a preview with [Отправить]/[Отмена] inline buttons, and — on
-- confirm — flips the row to 'sent' ATOMICALLY (update ... where status='draft') before the
-- send loop starts. That single-row state machine is the anti-double-send guard: a second
-- tap (or a Telegram callback replay that slips past the bot_updates dedup) matches 0 rows
-- and never re-broadcasts. sent_at + sent_n + skipped_n record the outcome for the report.
--
-- Recipients are read live at send time (users where allows_write_to_pm and not is_blocked),
-- so this table stores only the message + its lifecycle, NOT a per-recipient fan-out. A 403
-- during the loop flips that user's users.is_blocked (same signal as the notify worker), so a
-- later broadcast skips them up front.
--
-- DRAFT — DO NOT APPLY automatically (rule #4). The internal side applies it. Apply order
-- (Neon): after draft_0001_init.sql (needs pgcrypto's gen_random_uuid); it touches only this
-- new table, so any position after 0001 is fine.

-- ─────────────────────────────────────────────────────────────────────────────
-- broadcasts — one row per admin broadcast, a tiny draft→sent/cancelled state machine.
--   status : 'draft'     — created by /broadcast, awaiting the admin's confirm/cancel tap.
--            'sent'      — claimed atomically the instant [Отправить] is pressed (before the
--                          loop), so a re-tap cannot re-send. sent_at/sent_n/skipped_n fill in.
--            'cancelled' — [Отмена] pressed while still a draft.
--   text   : the exact message body the admin typed (plain text; sent with NO parse_mode).
--   sent_n / skipped_n : delivery tally, written once the loop finishes (NULL until then).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists broadcasts (
  id         uuid primary key default gen_random_uuid(),
  text       text not null,
  status     text not null default 'draft',
  created_at timestamptz not null default now(),
  sent_at    timestamptz,
  sent_n     integer,
  skipped_n  integer,
  constraint ck_broadcasts_status check (status in ('draft', 'sent', 'cancelled'))
);

comment on table broadcasts is 'Admin /broadcast messages; draft->sent/cancelled state machine. status=sent is claimed atomically before the send loop (anti-double-send). sent_n/skipped_n = delivery tally.';
