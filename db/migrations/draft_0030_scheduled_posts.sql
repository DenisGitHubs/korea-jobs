-- draft_0030_scheduled_posts.sql
-- korea-jobs — «отложенные публикации» (owner tool, 2026-08-01).
-- ADDITIVE / IDEMPOTENT / NON-DESTRUCTIVE: three new tables + two new columns on user_ads +
-- config seeds. Nothing existing is dropped, renamed or rewritten.
--
-- WHY
-- The owner (the ONLY admin) wants to prepare a post once and have the bot publish it later —
-- optionally repeating it N times — without sitting at the keyboard. He sends the bot
--   /post
--   когда: завтра 09:00
--   ...
--   ---
--   текст объявления
-- (optionally as the CAPTION of a photo). The bot shows a preview with [Запланировать]/[Отмена];
-- on confirm the row here goes 'active' and a cron worker (lib/korea/scheduled/run.ts) publishes it
-- into user_ads at the appointed time.
--
-- TWO KINDS OF POST (owner decision + Законник, 2026-08-01)
--   kind='ad'    — an ordinary listing: it lands in the feed AND (when notify=true) is pushed to
--                  subscribers through the EXISTING notify worker (filters + per-user daily cap).
--   kind='promo' — a PAID placement. It is labelled «Реклама», lives ONLY in the feed and is NEVER
--                  sent to anybody's DM. That ban is enforced in code (notify/run.ts) and by the
--                  publisher never setting notify_pending on a promo row; this file only carries
--                  the flag (user_ads.promo) the feed and the guards read.
-- A promo row is NOT made to look "better" than an ordinary one (no pinning, no boost): it is an
-- ordinary card in the ordinary stream carrying an honest label — selling a QUALITY SIGNAL is what
-- the law forbids, selling VISIBILITY is not.
--
-- REPEATS DO NOT FAKE FRESHNESS (Законник). A repeat does NOT bump the old card's date; it creates
-- a NEW publication and ARCHIVES the previous one (so the feed never collects duplicates of the same
-- offer). The link between the two is scheduled_post_runs.ad_id.
--
-- IDEMPOTENCY. scheduled_post_runs' PRIMARY KEY (schedule_id, run_no) IS the idempotency key: the
-- worker CLAIMS the run row first and publishes second, so a duplicated cron tick (or two concurrent
-- serverless invocations) can never publish the same run twice.
--
-- MEDIA. A photo the owner attaches is downloaded from Telegram ONCE, at scheduling time, and stored
-- as bytes in media_files; the app serves it from our own origin (GET /api/media/:id). We never hand
-- a client an api.telegram.org/file/bot<TOKEN>/... URL — that URL contains the bot token.
--
-- DRAFT — DO NOT APPLY; the internal side applies it (db/apply.mjs, appended to the end of the list).
-- Depends on: pgcrypto's gen_random_uuid + users + user_ads + config (draft_0001/0003).

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- media_files — bytes of an image the owner attached to a scheduled post.
--
-- WHY BYTES IN POSTGRES and not a bucket: this is the owner's own low-volume tool (a handful of
-- images), the project has no object storage, and a Telegram file_id is NOT a public URL (resolving
-- it needs the bot token). Storing the bytes keeps the token server-side and makes the image a
-- normal, cacheable same-origin asset.
--
-- sha256 is UNIQUE: re-sending the same picture reuses the stored row instead of doubling it.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists media_files (
  id          uuid primary key default gen_random_uuid(),
  sha256      text not null unique,
  mime        text not null,
  bytes       bytea not null,
  width       integer,
  height      integer,
  size_bytes  integer not null,
  tg_file_id  text,
  uploaded_by uuid references users (id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table media_files is
  'Images attached to scheduled posts. Bytes are downloaded from Telegram ONCE (getFile) and served by GET /api/media/:id from our own origin — a Telegram file URL carries the bot token and must never reach a client. Deduped by sha256. Unreferenced rows are purged after 7 days by cleanup/run.ts.';
comment on column media_files.tg_file_id is 'The Telegram file_id we downloaded from (kept for tracing/re-send; NOT a public URL).';

-- ─────────────────────────────────────────────────────────────────────────────
-- user_ads gains two columns.
--   media_id : the picture shown on the card (NULL = text-only, i.e. every ad that exists today).
--   promo    : true = a PAID placement labelled «Реклама». Feed-only; never notified.
-- Both are additive with safe defaults, so every existing row keeps behaving exactly as before.
-- ─────────────────────────────────────────────────────────────────────────────
alter table user_ads add column if not exists media_id uuid references media_files (id) on delete set null;
alter table user_ads add column if not exists promo boolean not null default false;

comment on column user_ads.media_id is 'Optional image (media_files). The app renders it via GET /api/media/<id>.';
comment on column user_ads.promo is
  'true = paid placement, labelled «Реклама» in the app. NEVER pushed to DMs (notify/run.ts skips it); no visual privilege over ordinary cards.';

-- Partial index: the feed/notify guards ask "is this ad a promo" only for live rows.
create index if not exists idx_user_ads_promo on user_ads (promo) where status = 'approved';
-- The media purge asks "is this file still referenced by an ad".
create index if not exists idx_user_ads_media on user_ads (media_id) where media_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- scheduled_posts — one row per planned publication (a small state machine).
--   status  'draft'     — created by /post, waiting for the owner's [Запланировать]/[Отмена];
--           'active'    — confirmed; the worker publishes it at next_run_at;
--           'done'      — every planned run happened;
--           'cancelled' — [Отмена] (or /posts → Отменить);
--           'failed'    — publishing kept failing (see last_error / fail_count).
--   payload — the VALIDATED ad fields (title/description/contact/work_type/city…), already clamped
--             at parse time, so publishing is a straight INSERT with no re-parsing of user text.
--   interval_minutes NULL = publish once; otherwise the gap between runs.
--   total_runs / done_runs — how many publications are planned / already made.
--   notify  — ask the EXISTING notify worker to push this to matching subscribers. Forced false for
--             kind='promo' (paid placements never enter anybody's DM).
-- text + CHECK on purpose (no enums): a new status/kind then needs no ALTER TYPE.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists scheduled_posts (
  id               uuid primary key default gen_random_uuid(),
  created_by       uuid references users (id) on delete set null,
  kind             text not null default 'ad',
  payload          jsonb not null,
  media_id         uuid references media_files (id) on delete set null,
  start_at         timestamptz not null,
  interval_minutes integer,
  total_runs       integer not null default 1,
  done_runs        integer not null default 0,
  next_run_at      timestamptz,
  notify           boolean not null default false,
  status           text not null default 'draft',
  last_run_at      timestamptz,
  last_error       text,
  fail_count       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint ck_scheduled_posts_kind   check (kind in ('ad', 'promo')),
  constraint ck_scheduled_posts_status check (status in ('draft', 'active', 'done', 'cancelled', 'failed')),
  constraint ck_scheduled_posts_runs   check (total_runs >= 1 and done_runs >= 0),
  constraint ck_scheduled_posts_gap    check (interval_minutes is null or interval_minutes > 0)
);

comment on table scheduled_posts is
  'Owner tool: posts prepared via /post and published later by lib/korea/scheduled/run.ts. kind=promo is a paid «Реклама» placement — feed only, never notified.';
comment on column scheduled_posts.payload is 'Validated ad fields (title, description, contact_raw, work_type, city_slug…), clamped at parse time.';
comment on column scheduled_posts.notify is 'Push to matching subscribers through the ordinary notify worker. Always false for kind=promo.';

-- The worker's only hot query: "which active schedules are due".
create index if not exists idx_scheduled_posts_due
  on scheduled_posts (next_run_at)
  where status = 'active';
-- /posts (the owner's list).
create index if not exists idx_scheduled_posts_owner on scheduled_posts (created_by, created_at desc);

drop trigger if exists trg_scheduled_posts_updated_at on scheduled_posts;
create trigger trg_scheduled_posts_updated_at
  before update on scheduled_posts
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- scheduled_post_runs — the journal AND the idempotency key.
--
-- PRIMARY KEY (schedule_id, run_no): the worker inserts the run row BEFORE publishing, so a
-- duplicated tick / a concurrent invocation loses the race and skips. A run is re-claimable only
-- when it previously FAILED or is a stale 'running' (a serverless invocation that died mid-flight)
-- — see lib/korea/scheduled/run.ts.
--
-- ad_id references the user_ads row this run created, ON DELETE SET NULL: deleting a published ad
-- must never delete the history of the schedule. It is also what lets the NEXT run archive the
-- PREVIOUS publication instead of letting duplicates pile up in the feed.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists scheduled_post_runs (
  schedule_id uuid not null references scheduled_posts (id) on delete cascade,
  run_no      integer not null,
  ad_id       uuid references user_ads (id) on delete set null,
  status      text not null default 'running',
  error       text,
  ran_at      timestamptz not null default now(),
  primary key (schedule_id, run_no),
  constraint ck_scheduled_post_runs_status check (status in ('running', 'done', 'failed'))
);

comment on table scheduled_post_runs is
  'One row per publication attempt of a scheduled post. PK (schedule_id, run_no) is the idempotency key: claim first, publish second. ad_id links the created user_ads row (ON DELETE SET NULL).';

create index if not exists idx_scheduled_post_runs_ad on scheduled_post_runs (ad_id) where ad_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Config seeds. ON CONFLICT DO NOTHING — an owner-tuned value is never overwritten.
--   scheduled_enabled        — master switch of the publishing worker (false = it does nothing at
--                              all; the schedules just wait, nothing is lost);
--   scheduled_batch          — schedules published per worker tick;
--   scheduled_max_fails      — consecutive failures before a schedule is parked as 'failed';
--   scheduled_media_max_bytes— hard ceiling on a downloaded photo (Telegram's largest size is well
--                              under this; the bytes travel through the SQL statement as hex);
--   scheduled_notify_owner   — DM the owner when a scheduled post actually went out.
-- ─────────────────────────────────────────────────────────────────────────────
insert into config (key, value) values
  ('scheduled_enabled',         'true'::jsonb),
  ('scheduled_batch',           '5'::jsonb),
  ('scheduled_max_fails',       '3'::jsonb),
  ('scheduled_media_max_bytes', '2000000'::jsonb),
  ('scheduled_notify_owner',    'true'::jsonb)
on conflict (key) do nothing;

commit;

-- VERIFY (read-only, after apply):
--   -- the three tables + the two new user_ads columns exist:
--   select table_name from information_schema.tables
--    where table_name in ('media_files', 'scheduled_posts', 'scheduled_post_runs') order by 1;
--   select column_name from information_schema.columns
--    where table_name = 'user_ads' and column_name in ('media_id', 'promo') order by 1;
--
--   -- nothing is scheduled yet (expected right after apply):
--   select status, count(*) from scheduled_posts group by status;
--
--   -- what is due next:
--   select id, kind, status, next_run_at, done_runs, total_runs
--     from scheduled_posts where status = 'active' order by next_run_at;
--
--   -- the four knobs:
--   select key, value from config where key like 'scheduled_%' order by key;
--
--   -- SANITY (must stay 0): a promo ad queued for a DM.
--   select count(*) from user_ads where promo and notify_pending;
