-- draft_0027_inactive_erase.sql
-- korea-jobs — RETENTION FOR PEOPLE: erase the personal data of an account that has not
-- been used for N months (default 12), so the Privacy Policy promise («удаляем данные
-- через 12 месяцев без входа») is backed by a real mechanism.
-- ADDITIVE / IDEMPOTENT / NON-DESTRUCTIVE BY ITSELF (this file deletes NOTHING; it only
-- adds a column, relaxes one NOT NULL, adds an index and seeds config — with the master
-- switch seeded OFF, so applying it changes no behaviour at all).
--
-- WHY A COLUMN AT ALL
-- The "last activity" signal already exists and is trustworthy: users.last_seen_at is
-- stamped now() by EVERY authenticated Mini App request (lib/korea/core/context.ts upsert)
-- and by every /start in the bot (lib/korea/bot/webhook.ts). It costs nothing extra — both
-- paths were already writing that row. What was missing is a way to remember that an
-- account has ALREADY been erased, so the sweep is idempotent and never touches a tombstone
-- twice: that is `deleted_at`.
--
-- WHAT THE SWEEP DOES (lib/korea/cleanup/inactive.ts) — "стереть личное, оставить пустой узел"
--   * DELETES every row that belongs to the person: subscriptions, saved_*, *_contact_reveals,
--     notifications_sent, vacancy_reports, streak_awards, cooperation_requests, their own
--     referral_points_ledger credits, their user_ads (so the ad leaves the feed), and their
--     bot_updates rows (which hold the raw telegram id).
--   * STRIPS the users row of every identifier (telegram_id, username, first_name, last_name,
--     a fresh public_id) and stamps deleted_at. The row survives ONLY as an anonymous graph
--     node so that OTHER people's referral chains and point balances stay intact.
--   * KEEPS referral_activations — deliberately. referral_points_ledger.activation_id is
--     `on delete cascade`, so deleting an invitee's activation row would CASCADE-DELETE the
--     credits their INVITER already earned. Keeping the (personal-data-free) activation row
--     is what makes "erase one person" safe for everybody else.
--
-- WHY telegram_id MUST BECOME NULLABLE
-- telegram_id IS the personal identifier. Erasure that leaves it in place is not erasure.
-- There is no row with a NULL telegram_id today and none can appear until the sweep is
-- switched ON, so this relaxation is invisible and reversible until then. Nothing inserts a
-- NULL: both upserts always supply the id, and `on conflict (telegram_id)` still infers the
-- unique index (Postgres allows many NULLs in a unique index, so tombstones never collide).
-- Downstream is already safe: broadcast picks `allows_write_to_pm and not is_blocked` (a
-- tombstone has false), notify/digest join `subscriptions` (deleted), adminRecipients skips
-- NULL ids, and the referral-code lookup `where public_id = $1 and telegram_id <> $2` yields
-- NULL (= no row) for a tombstone, so an erased account can never be attributed as an inviter.
--
-- Re-applying is a no-op (ADD COLUMN IF NOT EXISTS / DROP NOT NULL / CREATE INDEX IF NOT
-- EXISTS / ON CONFLICT DO NOTHING).
--
-- APPLY ORDER: BEFORE the matching code deploy — lib/korea/cleanup/inactive.ts references
-- users.deleted_at directly (same convention as draft_0017 / draft_0020 / draft_0026). The
-- endpoint is a guarded no-op while inactive_delete_enabled is false, so the order is not
-- critical, but keep it.
--
-- Depends on: users (draft_0001_init.sql, extended by 0003_consent / 0004_referral /
-- 0005_onboarding / 0018_streaks).
--
-- DRAFT — DO NOT APPLY; the internal side applies it (db/apply.mjs, appended to the end of
-- the list).

begin;

-- (1) The tombstone stamp. NULL = a live account (every row today). NOT NULL = the account's
--     personal data has been erased; the row is kept ONLY as an anonymous referral-graph node.
alter table users
  add column if not exists deleted_at timestamptz;

comment on column users.deleted_at is
  'When this account''s personal data was erased by the inactivity sweep (lib/korea/cleanup/inactive.ts). NULL = live account. A stamped row keeps NO identifiers (telegram_id/username/names nulled, public_id rotated) and exists only so other people''s referral chains and point balances stay intact.';

-- (2) Make the identifier removable. See the "WHY telegram_id MUST BECOME NULLABLE" note
--     above. No row is rewritten; only the constraint is relaxed. The UNIQUE index stays.
alter table users
  alter column telegram_id drop not null;

comment on column users.telegram_id is
  'Telegram user id — backend-only, never leaves the server. NULL ONLY on an erased (deleted_at) tombstone: erasure removes the identifier itself. Many NULLs are allowed by the unique index, so tombstones never collide.';

-- (3) The sweep's scan index: "oldest dormant LIVE accounts first". Partial on the live rows,
--     so the growing pile of tombstones costs nothing to skip.
create index if not exists idx_users_last_seen_live
  on users (last_seen_at)
  where deleted_at is null;

-- (4) Config (idempotent; tune without a deploy).
--     inactive_delete_enabled is seeded FALSE ON PURPOSE — the owner turns it on after we have
--     watched a dry run. While it is false the cron endpoint returns { ok: true, enabled: false }
--     and does not touch a single row.
insert into config (key, value) values
  ('inactive_delete_enabled',     'false'),  -- MASTER SWITCH. false = the sweep erases nothing.
  ('inactive_delete_months',      '12'),     -- erase after N months with no login (clamped to 1..120 in code)
  ('inactive_delete_batch',       '200'),    -- accounts per batch (clamped to 1..1000); keeps every statement short
  ('inactive_delete_max_batches', '5')       -- max batches per tick (clamped to 1..50); the tick also has a time budget
on conflict (key) do nothing;

commit;

-- VERIFY (read-only, after apply):
--   -- column present and nullable; telegram_id now nullable:
--   select column_name, is_nullable from information_schema.columns
--   where table_name = 'users' and column_name in ('deleted_at', 'telegram_id');
--   -- expected: deleted_at | YES   and   telegram_id | YES
--
--   -- the switch is OFF and the term is 12 months:
--   select key, value from config where key like 'inactive_delete%';
--
--   -- NOBODY is erased yet (must be 0 right after apply):
--   select count(*) as tombstones from users where deleted_at is not null;
--
--   -- DRY RUN — how many accounts the sweep WOULD erase at 12 months (run this before
--   -- flipping the switch; it only reads):
--   select count(*) as would_erase
--   from users
--   where deleted_at is null and role <> 'admin'
--     and last_seen_at < now() - interval '12 months'
--     and created_at   < now() - interval '12 months';
--
--   -- TURN IT ON (owner's call, after the dry run looks sane):
--   --   update config set value = 'true'::jsonb where key = 'inactive_delete_enabled';
--   -- TURN IT OFF again (instant, no deploy):
--   --   update config set value = 'false'::jsonb where key = 'inactive_delete_enabled';
