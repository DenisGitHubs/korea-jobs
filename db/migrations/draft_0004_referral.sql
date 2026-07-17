-- draft_0004_referral.sql
-- korea-jobs — 3-level referral graph + loyalty points accrual. ADDITIVE ONLY.
--
-- DRAFT ONLY. Do NOT apply automatically (rule #4). Apply order (Neon):
--   0001 -> seed -> sources_seed -> 0003_* -> 0004_referral. See db/README.md.
--
-- Model (Sanya/Roma, owner-approved plan):
--   * users gets a fixed-depth (3) ancestor snapshot: referred_by (L1) + ref_l2 + ref_l3.
--     Set ONCE at insert time (first touch wins, immutable). Depth is capped at 3 and the
--     values are copied from the referrer's own snapshot, so cycles are structurally
--     impossible and no recursion is ever needed to walk the tree.
--   * BALANCE has a SINGLE source of truth: sum(referral_points_ledger.amount) where
--     status='confirmed'. There is deliberately NO cached balance column on users — a
--     cache would drift, break on cascade-deletes of an invitee, and need a decrement on
--     void/clawback. Reads (/api/me, /api/referral) sum the ledger; the confirm cron only
--     flips row status (never writes a balance).
--   * referral_activations: one row per invited user, forever (user_id UNIQUE). The anchor
--     of idempotency — "this invitee's target action has been recorded" can happen once.
--   * referral_points_ledger: append-only credit rows for the invitee's ancestors. The
--     idempotent key UNIQUE(activation_id, user_id) (activation_id NOT NULL) means each
--     ancestor is credited at most once per activation. Rows are born 'pending' and flip to
--     'confirmed' after a delay (anti-fraud); L1 uses a diminishing rate + a hard wall
--     (over the cap -> 'void', terminal), L2/L3 use a daily cap + drip.
--
-- CLAWBACK RUNBOOK (no code needed — the ledger is the only truth):
--   1. mark suspect users: update users set referral_flagged = true where <criteria>;
--   2. void their fraudulently-earned credits:
--        update referral_points_ledger set status = 'void'
--        where source_user_id in (select id from users where referral_flagged) and status = 'confirmed';
--   3. done — every balance (sum of confirmed ledger rows) recomputes itself on next read.

-- ─────────────────────────────────────────────────────────────────────────────
-- users — 3-level ancestor snapshot (no cached balance — the ledger is the truth).
--   referred_by : direct inviter (L1). FK -> users, on delete set null.
--   ref_l2      : the inviter's inviter (L2). Immutable snapshot -> plain uuid (no FK,
--   ref_l3      : the L2's inviter (L3).      so a deleted ancestor never rewrites history).
-- ─────────────────────────────────────────────────────────────────────────────

alter table users
  add column if not exists referred_by      uuid references users (id) on delete set null,
  add column if not exists ref_l2           uuid,
  add column if not exists ref_l3           uuid,
  add column if not exists referral_flagged boolean not null default false;

comment on column users.referred_by is 'Direct inviter (L1). Set at insert, or once on an EMPTY row inside the bind window; then immutable.';
comment on column users.ref_l2       is 'L2 ancestor snapshot (inviter of the inviter). Immutable, denormalized.';
comment on column users.ref_l3       is 'L3 ancestor snapshot. Immutable, denormalized.';
comment on column users.referral_flagged is 'Manual review flag (Хейтер): marks a user whose referral history is suspect and subject to a later void/recompute. Never set by request handlers.';

create index if not exists idx_users_referred_by on users (referred_by);
create index if not exists idx_users_ref_l2      on users (ref_l2);
create index if not exists idx_users_ref_l3      on users (ref_l3);

-- ─────────────────────────────────────────────────────────────────────────────
-- referral_activations — one activation per invited user, EVER. user_id UNIQUE is the
-- idempotency anchor: the invitee's target action (first contact reveal) credits their
-- ancestors exactly once, no matter how many times they repeat it.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists referral_activations (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null unique references users (id) on delete cascade,
  kind         text not null default 'contact_reveal',
  status       text not null default 'pending',
  eligible_at  timestamptz,
  created_at   timestamptz not null default now(),
  confirmed_at timestamptz
);

comment on table referral_activations is 'One activation per invited user (user_id UNIQUE) — the accrual idempotency anchor.';

-- ─────────────────────────────────────────────────────────────────────────────
-- referral_points_ledger — append-only credit rows for an invitee's ancestors.
-- UNIQUE(activation_id, user_id): each ancestor is credited at most once per activation.
-- amount is a SNAPSHOT of the rate at accrual time (config can change later without
-- rewriting history). level is 1/2/3. source_user_id is the invitee who triggered it.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists referral_points_ledger (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users (id) on delete cascade,        -- recipient (ancestor)
  amount         integer  not null,
  level          smallint not null,                                            -- 1 | 2 | 3
  reason         text     not null default 'activation',
  source_user_id uuid references users (id) on delete set null,                -- the invitee who triggered it
  activation_id  uuid not null references referral_activations (id) on delete cascade,
  status         text not null default 'pending',                             -- pending | confirmed | void
  eligible_at    timestamptz,
  created_at     timestamptz not null default now(),
  confirmed_at   timestamptz,
  constraint uq_ledger_activation_user unique (activation_id, user_id)
);

comment on table referral_points_ledger is 'Referral credits; UNIQUE(activation_id,user_id) = idempotent per-ancestor accrual. Balance = sum(amount) where confirmed (the ONLY source of truth).';
comment on column referral_points_ledger.amount is 'Born as the level-rate snapshot at accrual; rewritten to the EFFECTIVE credited value on confirm (L1 diminishing/wall). Confirmed sum = the balance.';

create index if not exists idx_ledger_user_status      on referral_points_ledger (user_id, status);
create index if not exists idx_ledger_pending_eligible on referral_points_ledger (eligible_at) where status = 'pending';
create index if not exists idx_ledger_source           on referral_points_ledger (source_user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Config (idempotent; tune without a deploy). Rates are conditional — the RATIO
-- (L1 > L2 > L3) matters more than the absolute numbers.
-- ─────────────────────────────────────────────────────────────────────────────

insert into config (key, value) values
  ('referral_enabled',                    'true'),                -- master switch for attribution + accrual
  ('referral_points_l1',                  '100'),                 -- credit to the direct inviter
  ('referral_points_l2',                  '30'),                  -- credit to the L2 ancestor
  ('referral_points_l3',                  '10'),                  -- credit to the L3 ancestor
  ('referral_confirm_delay_hours',        '48'),                  -- anti-fraud hold before pending -> confirmed
  ('referral_daily_confirm_cap',          '20'),                  -- SHARED daily confirmations per recipient across ALL levels (L1+L2+L3, by design); excess drips
  -- L1 confirmation economics: diminishing return + a HARD wall (no drip past the wall).
  -- L2/L3 keep the simpler model (daily cap + drip); they are secondary and low-value.
  ('referral_l1_full_count',              '20'),                  -- first N confirmed L1 credit at the full rate
  ('referral_l1_hard_cap',                '100'),                 -- past N confirmed L1 -> 0 credit, TERMINAL (voided, not deferred)
  ('referral_l1_diminish_num',            '1'),                   -- reduced-rate numerator   (full_count < pos <= hard_cap)
  ('referral_l1_diminish_den',            '2'),                   -- reduced-rate denominator (=> half rate by default)
  ('referral_l2l3_lifetime_cap',          '2000'),                -- lifetime confirmed L2+L3 rows per recipient; beyond -> void (generous)
  ('referral_bind_window_hours',          '72'),                  -- attribution allowed on an EMPTY existing row within N h of signup
  -- confirm-cron operational knobs
  ('referral_confirm_lock',               '{"token": "", "ts": 0}'), -- single-flight lease {token, ts(epoch secs)}; ts=0 = free
  ('referral_confirm_lock_ttl_seconds',   '300'),                 -- a held lease is considered stale/abandoned after N s
  ('referral_confirm_batch_recipients',   '1000'),                -- max recipients processed per tick (guards statement-timeout)
  ('referral_confirm_batch_rows',         '5000'),                -- max total ledger rows processed per tick (guards statement-timeout)
  ('referral_activation_kind',            '"contact_reveal"'),    -- the target action that triggers accrual
  ('referral_activation_on_subscription', 'false'),               -- secondary trigger (subscription) — reserved, OFF
  -- Share-link identity. Seeded EMPTY so the keys are visible for ops to fill; env vars
  -- REFERRAL_BOT_USERNAME / REFERRAL_APP_SHORTNAME override them. Until one pair is set,
  -- GET /api/referral falls back to a (non-deep-link) APP_URL — see read.ts.
  ('referral_bot_username',               '""'),                  -- bot username WITHOUT '@' (e.g. "korea_rabota_bot")
  ('referral_app_shortname',              '""')                   -- Mini App short-name from BotFather (e.g. "app")
on conflict (key) do nothing;

-- NOTE (ops): the share link is built server-side as
--   https://t.me/<bot>/<app>?startapp=<public_id>
-- Fill referral_bot_username + referral_app_shortname (above) OR the matching env vars once
-- the bot username and Mini App short-name are final, e.g.:
--   update config set value = '"korea_rabota_bot"' where key = 'referral_bot_username';
--   update config set value = '"app"'              where key = 'referral_app_shortname';
