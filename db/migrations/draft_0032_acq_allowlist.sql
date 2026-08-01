-- draft_0032_acq_allowlist.sql
-- korea-jobs — БЕЛЫЙ СПИСОК меток источника + счётчик отклонённых (2026-08-02).
-- ADDITIVE / IDEMPOTENT / NON-DESTRUCTIVE: ONE config seed + ONE tiny counter table.
-- Nothing is dropped, renamed or rewritten; not a single users row is touched.
--
-- WHY (legal review, 02.08.2026 — closes a hole in draft_0031)
-- draft_0031 stores users.acq_source from the deep link, and the parser only checks the SHAPE of
-- the label (`ads_<slug>` / `s_<slug>`). Shape is not meaning, and two things follow:
--   1. `startapp` is a public URL tail — ANY person can open
--      t.me/korea_rabota_bot/app?startapp=s_ivan_petrov_seoul and write an arbitrary string into
--      their own row. That string is deliberately kept when the account is erased (statistics),
--      i.e. free third-party text would outlive deletion.
--   2. Even the owner could label a PERSON instead of a CHANNEL (`s_uzbeki`, `ads_nelegaly`).
--      Nationality / migration status is a special category of personal data: it needs its own
--      legal basis and its own consent, which we do not ask for and do not have.
-- Fixing the regex cannot help (no pattern can tell a channel name from an ethnic one), so the
-- rule is inverted: a label is recorded ONLY if it is in the approved list below. Everything
-- else -> NULL. The person still enters the app; we simply learn nothing about their channel.
--
-- FAIL-CLOSED BY DESIGN. If this key is missing or its list is empty, NO label is ever stored
-- (lib/korea/core/acq-source.ts). A forgotten setup costs statistics; the opposite default would
-- keep the hole open until somebody noticed. So that "forgotten" stays visible, /stats prints the
-- effective list and a weekly count of labels that missed it.
--
-- APPLY THIS BEFORE STARTING THE ADS. Between the code deploy and this file the list is empty,
-- which means every campaign click arrives unlabelled (and is counted in acq_rejects below).
--
-- DRAFT — DO NOT APPLY; the internal side applies it (db/apply.mjs, appended to the end of the
-- list). Depends on: config (draft_0001) and, in meaning only, users.acq_source (draft_0031).

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- (1) The approved labels. jsonb ARRAY of strings; edited later without a deploy
--     (the server cache refreshes within 60 seconds).
--
--     Seeded with exactly the four campaigns the owner is about to run
--     (_docs/ads/telegram-ads-brief.md §4): two Russian texts and two Uzbek ones.
--     ON CONFLICT DO NOTHING — re-applying never overwrites a list he has edited.
--
--     Comparison is case-insensitive and `-` folds to `_` (the parser's own normalization is
--     reused for BOTH sides), so 'ADS_RU1' or 'ads-ru1' in this list still matches ads_ru1.
--
--     ADD A LABEL:
--       update config
--          set value = value || '["ads_ru3"]'::jsonb, updated_at = now()
--        where key = 'acq_sources_allowed';
--     REMOVE ONE (stops counting NEW people; already labelled rows keep their label):
--       update config
--          set value = (select jsonb_agg(x) from jsonb_array_elements(value) t(x)
--                        where x <> '"ads_ru3"'::jsonb), updated_at = now()
--        where key = 'acq_sources_allowed';
--     TURN THE WHOLE MECHANISM OFF (nothing is labelled any more):
--       update config set value = '[]'::jsonb, updated_at = now()
--        where key = 'acq_sources_allowed';
-- ─────────────────────────────────────────────────────────────────────────────

insert into config (key, value) values
  ('acq_sources_allowed', '["ads_ru1","ads_ru2","ads_uz1","ads_uz2"]'::jsonb)
on conflict (key) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) Counter of labels that arrived but were NOT on the list (owner typo in the ad cabinet,
--     a label he forgot to add, or a stranger's experiment).
--
--     ONE ROW PER DAY, TWO COLUMNS, NO VALUES AND NO USER. Storing the rejected string is
--     precisely what we are refusing to do — the whole point of the allow-list — so the table
--     keeps a date and a number. Consequences on purpose:
--       * nothing here is personal data, nothing to erase on request, nothing to leak;
--       * the owner still learns «за неделю мимо списка прошло N меток», which is the signal
--         that he mistyped something, without ever seeing somebody else's text.
--     Written best-effort by lib/korea/core/acq-source.ts (a failure never blocks a login),
--     read by admin /stats. Grows by at most 365 rows a year — no purge needed.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists acq_rejects (
  day date primary key,
  n   integer not null default 0
);

comment on table acq_rejects is
  'Per-day COUNT of deep-link acquisition labels that were well-formed but NOT in config.acq_sources_allowed. Values are never stored (that is the point of the allow-list) and no user is referenced: one date + one number. Written best-effort on the auth / bot /start paths, read by admin /stats as «меток мимо списка за неделю».';

comment on column acq_rejects.day is
  'Asia/Seoul calendar day of the rejections, matching the timezone the rest of the product counts days in.';

commit;

-- VERIFY (read-only, after apply):
--   -- the list is there and holds the four campaigns:
--   select value from config where key = 'acq_sources_allowed';
--
--   -- the counter table exists and is empty:
--   select count(*) from acq_rejects;
--
--   -- nobody is labelled yet / everybody labelled carries an APPROVED label (must be empty):
--   select acq_source, count(*) from users
--    where acq_source is not null
--      and not (to_jsonb(acq_source) <@ (select value from config where key = 'acq_sources_allowed'))
--    group by 1;
--
--   -- what /stats prints (labels + rejections over the last 7 days):
--   select acq_source, count(*)::int as total,
--          count(*) filter (where created_at > now() - interval '7 days')::int as week
--     from users where acq_source is not null group by 1 order by 2 desc, 1;
--   select coalesce(sum(n), 0)::int as rejects_7d from acq_rejects
--    where day >= ((now() at time zone 'Asia/Seoul')::date - 6);
