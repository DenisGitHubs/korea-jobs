// db/apply.mjs — one-off migration runner for Neon.
//
// Reads DATABASE_URL_UNPOOLED (fallback DATABASE_URL) from the local .env — never
// printed — and applies the draft migrations in order. draft_0002_rls.sql is
// intentionally NOT applied on Neon (Supabase-only). Run from the project root:
//   node db/apply.mjs
//
// Idempotency: every migration is written to be re-runnable (guarded enums,
// CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, seeds via ON CONFLICT), so
// re-applying the full list on a populated DB is safe. Keep new files idempotent.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from '@neondatabase/serverless';

// Resolve paths from this file's location (db/apply.mjs) so it runs from any cwd.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const MIG_DIR = join(ROOT, 'db', 'migrations') + '/';

function envVal(text, key) {
  const m = text.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim() : null;
}

const envText = readFileSync(ENV_PATH, 'utf8');
const url = envVal(envText, 'DATABASE_URL_UNPOOLED') || envVal(envText, 'DATABASE_URL');
if (!url) {
  console.error('FATAL: no DATABASE_URL(_UNPOOLED) in .env');
  process.exit(1);
}

const files = [
  'draft_0001_init.sql',
  'draft_seed.sql',
  'draft_sources_seed.sql',
  'draft_sources_seed_2.sql', // owner batch 2 (15.07) — 18 chats, idempotent by username

  // NOTE: draft_0002_rls.sql is Supabase-only and is INTENTIONALLY NOT listed here (see its
  // file header + db/README.md). On Neon there is no anon PostgREST surface, so RLS is not
  // applied; security lives in the serverless layer.

  // Phase 1 v2 (0003) — order matters: vacancy_fields creates the visa_type / placement_fee
  // enums that subscription_filters and user_ads depend on. moderation adds
  // raw_messages.reject_reason (0007 depends on it); user_ads creates the user_ads table
  // (0006 depends on it).
  'draft_0003_vacancy_fields.sql',
  'draft_0003_moderation.sql',
  'draft_0003_consent.sql',
  'draft_0003_takedown.sql',
  'draft_0003_subscription_filters.sql',
  'draft_0003_user_ads.sql',

  // Referral graph (0004) — ADDITIVE to users + config (both from 0001). Placed after the
  // 0003 block per its own header's documented apply order.
  'draft_0004_referral.sql',

  // Phase 2 redesign (0005) — ADDITIVE. visa_types MUST be its own file/transaction:
  // ALTER TYPE ADD VALUE cannot be used in the same tx that uses the new label (see the
  // header in draft_0005_visa_types.sql). apply.mjs sends one query per file, so each 0005
  // file is its own committed unit — the enum labels land before anything uses them.
  // visa_types extends the visa_type enum created in draft_0003_vacancy_fields.sql, so it
  // MUST run after that file.
  'draft_0005_visa_types.sql',
  'draft_0005_onboarding.sql',

  // Phase 3 redesign — ADDITIVE. saved (0006) FKs vacancies (0001) + user_ads (0003_user_ads);
  // raw_read (0007) adds a config tunable + a partial index over raw_messages using
  // reject_reason (0003_moderation) — both come after the 0003 block above.
  'draft_0006_saved.sql',
  'draft_0007_raw_read.sql',

  // Raw reveal (0008) — ADDITIVE. raw_contact_reveals audits UNVERIFIED-message reveals and
  // feeds the SHARED daily reveal cap (reveals24h counts contact_reveals + ad_contact_reveals
  // + this). Depends on users + raw_messages (0001). MUST be applied before the reveal code
  // goes live: reveals24h() is also used by GET /api/vacancies/:id/contact.
  'draft_0008_raw_reveal.sql',

  // Pre-AI exact-duplicate dedup (0009) — ADDITIVE. Adds raw_messages.text_hash + a partial
  // index. The parser fills text_hash lazily and dedups reposts BEFORE the model call; run
  // db/backfill_raw_text_hash.mts AFTER this to hash existing rows. Depends on raw_messages
  // (draft_0001_init.sql); reject_reason is already free text (draft_0003_moderation.sql).
  'draft_0009_raw_text_hash.sql',

  // Ad push + free-text city (0010) — ADDITIVE. Adds user_ads.city_text + user_ads.notify_pending
  // and extends notifications_sent with ad_id (guarded "one of vacancy_id/ad_id" CHECK + a partial
  // UNIQUE (user_id, ad_id)); uq_notif_user_vac is untouched. Lets the notify cron DM subscribers
  // about APPROVED user ads exactly like vacancies. Depends on user_ads (draft_0003_user_ads.sql)
  // and notifications_sent (draft_0001_init.sql).
  'draft_0010_ads_notify.sql',

  // Admin-hide guard (0011) — ADDITIVE. Adds vacancies.admin_hidden (boolean default false), set
  // alongside is_active=false when the admin hides a reported vacancy (bot rep:hide). Lets the
  // parser's repost/revive logic keep an admin hide from being overridden by a later repost.
  // Depends on vacancies (draft_0001_init.sql).
  'draft_0011_admin_hidden.sql',

  // "Мои объявления" (0012) — ADDITIVE. Adds the user_ad_status label 'archived' (ADD VALUE IF
  // NOT EXISTS — unused in-file, so it commits before first use) + user_ads.bumped_at + two
  // config tunables (bump/edit cooldowns). Lets an author bump/edit/archive/unarchive/delete
  // their own ad; the feed re-floats a bumped ad via greatest(created_at, bumped_at). Depends on
  // user_ads (draft_0003_user_ads.sql) and config (draft_0001_init.sql).
  'draft_0012_my_ads.sql',

  // Reveal FK decouple (0013) — ADDITIVE / idempotent. Turns raw_contact_reveals.raw_id from
  // ON DELETE CASCADE into ON DELETE SET NULL (and swaps the composite PK for a UNIQUE on the
  // same columns so raw_id can be nullable). Reason: the 24h raw purge (cleanup step 5) would
  // otherwise CASCADE-delete reveal audit rows and let reveals24h() under-count the shared daily
  // cap. Now a purged raw leaves its audit row alive (raw_id nulled); the cap counts by
  // (user_id, revealed_at) so it stays exact. Depends on raw_contact_reveals (draft_0008_raw_reveal.sql).
  'draft_0013_reveal_fk.sql',

  // Multi-contact normalize (0014) — ADDITIVE / idempotent (CREATE OR REPLACE). Since 2026-07-19
  // contact_raw may join several contacts with " · "; the old kj_normalize_contact treated the
  // whole list as one over-long phone (>13 digits -> NULL), which killed has_contact and collapsed
  // content_hash to 'nocontact' (distinct vacancies colliding). Now it keys on the FIRST contact
  // (split_part on " · ") before the existing logic. One function change: contact_normalized,
  // content_hash and kj_content_hash all call kj_normalize_contact, so has_contact + the stored
  // dedup hash + the parser's prospective hash stay in lockstep. Single values (no separator) are
  // byte-for-byte unchanged -> no recompute of existing rows. Depends on kj_normalize_contact /
  // kj_normalize_phone (draft_0001_init.sql).
  'draft_0014_multi_contact_norm.sql',

  // AI usage ledger (0015) — ADDITIVE / idempotent (CREATE TABLE IF NOT EXISTS). Adds ai_usage
  // (one row per SUCCESSFUL model call) + an index on called_at. Fed best-effort by the parser
  // (lib/korea/parser/run.ts) and the ad moderator (lib/korea/ads/moderation.ts) via
  // lib/korea/ai-usage.ts; read by admin /stats for a tokens + $ cost view. Depends on pgcrypto
  // (gen_random_uuid, draft_0001_init.sql). Stats reads it best-effort, so a deploy-before-apply
  // window degrades to zeros rather than breaking /stats.
  'draft_0015_ai_usage.sql',

  // AI reject journal (0016) — ADDITIVE / idempotent (CREATE TABLE IF NOT EXISTS). Adds two INTERNAL
  // tables: ai_reject_stats (per-day/per-reason counter, tiny, never purged) and ai_reject_samples
  // (FULL original text of AI-discarded messages, written best-effort by lib/korea/parser/run.ts only
  // while config 'reject_log_enabled' is on, purged > 7 days by lib/korea/cleanup/run.ts). No API/bot
  // surface reads them — owner-inspection only. Depends on pgcrypto (gen_random_uuid, draft_0001_init.sql).
  'draft_0016_reject_log.sql',

  // Daily digest (0017) — ADDITIVE / idempotent (ADD COLUMN IF NOT EXISTS). Adds
  // subscriptions.digest_enabled (default true) + subscriptions.last_digest_at + a partial index, so
  // lib/korea/digest/run.ts can DM opted-in subscribers one "N new vacancies" line each morning
  // (self-throttled via the config marker 'digest_last_run', written by the run — no seed here).
  // Depends on subscriptions (draft_0003_subscription_filters.sql / draft_0001_init.sql).
  'draft_0017_digest.sql',

  // Daily streaks (0018) — ADDITIVE / idempotent (ADD COLUMN IF NOT EXISTS + CREATE TABLE IF NOT
  // EXISTS). Adds users.{visit,open}_streak[_day] + the streak_awards table (one-time 7-day bonuses,
  // unique(user_id,kind,streak_len)). authenticate() advances the visit streak, vacancyDetail() the
  // open streak — both atomic + race-safe (WHERE guard on the Seoul-day). Balance becomes
  // sum(confirmed ledger) + sum(streak_awards); no config seed (defaults live in getConfigNumber).
  // Depends on users (draft_0001_init.sql) + config (draft_0001_init.sql); it is the streak
  // counterpart of the referral ledger (draft_0004_referral.sql).
  'draft_0018_streaks.sql',

  // Admin broadcast (0019) — ADDITIVE / idempotent (CREATE TABLE IF NOT EXISTS). Adds the
  // broadcasts table: one row per admin /broadcast, a draft->sent/cancelled state machine whose
  // atomic status flip (update ... where status='draft') is the anti-double-send guard, plus
  // sent_at/sent_n/skipped_n for the delivery report. No config seed (broadcast_send_cap default
  // lives in getConfigNumber). Depends only on pgcrypto (gen_random_uuid, draft_0001_init.sql).
  'draft_0019_broadcast.sql',

  // Multi-city (0020) — ADDITIVE / idempotent (ADD COLUMN IF NOT EXISTS + guarded UPDATE + CREATE
  // INDEX IF NOT EXISTS + CREATE OR REPLACE FUNCTION). Adds vacancies.city_ids / user_ads.city_ids
  // (uuid[]) + subscriptions.no_city, seeds city_ids from the single city_id ONLY where empty (the
  // `cardinality=0` guard makes re-apply idempotent AND never overwrites the richer multi-city sets
  // the parser/db/backfill_city_ids.mts write), two partial GIN indexes, and the shared immutable
  // kj_city_match() predicate used by the feed + digest. content_hash / kj_content_hash / city_id are
  // untouched. Run db/backfill_city_ids.mts AFTER this to enrich the existing corpus from message text.
  // Depends on vacancies / user_ads / subscriptions / cities (draft_0001_init.sql, draft_0003_user_ads.sql).
  'draft_0020_city_ids.sql',

  // Regions + conditional AI-geo (0021) — ADDITIVE / idempotent (ADD COLUMN IF NOT EXISTS + guarded
  // UPDATE + CREATE INDEX IF NOT EXISTS + CREATE OR REPLACE FUNCTION + CREATE TABLE IF NOT EXISTS).
  // Adds vacancies.region_slugs / user_ads.region_slugs / subscriptions.region_slugs (text[]), seeds
  // them from the row's cities' regions ∪ the singular region_slug ONLY where empty (idempotent guard),
  // two partial GIN indexes + a subscriptions GIN, the shared immutable kj_geo_match() predicate used by
  // the feed + digest (supersedes kj_city_match there; kj_city_match kept for compat), and the
  // geo_suggestions learning ledger (owner-only, read by admin /stats, written best-effort by the parser).
  // content_hash / kj_content_hash / city_id / city_ids untouched. Run db/backfill_city_ids.mts AFTER this
  // to enrich the existing corpus's region_slugs (it fills BOTH city_ids and region_slugs). Depends on
  // vacancies / user_ads / subscriptions / cities (draft_0001_init.sql, draft_0003_user_ads.sql) + the
  // city_ids columns (draft_0020_city_ids.sql) + pgcrypto (gen_random_uuid, draft_0001_init.sql).
  'draft_0021_regions.sql',

  // AI verdict cache (0022) — ADDITIVE / idempotent (CREATE TABLE IF NOT EXISTS). Adds ai_verdict_cache
  // (text_hash pk, reject_reason, n, last_seen) + an index on last_seen. Lets the parser
  // (lib/korea/parser/run.ts, via lib/korea/parser/verdict-cache.ts) skip the model for an EXACT repeat of
  // a message it already judged a NON-vacancy reject — using a floor-less hash so SHORT spam/chit-chat
  // lines (which the 40-char raw_messages.text_hash dedup ignores) collapse here. Never caches
  // low_confidence or a vacancy. Written/read best-effort (a fault never breaks a parse), purged > 7 days
  // by lib/korea/cleanup/run.ts. INTERNAL — no API/bot surface reads it. Depends only on stock Postgres.
  'draft_0022_verdict_cache.sql',

  // Persisted original-post link (0023) — ADDITIVE / idempotent (ADD COLUMN IF NOT EXISTS). Adds
  // vacancies.source_post_url (text, nullable): the "открыть в канале" deep link
  // (https://t.me/<sources.username>/<tg_message_id>) is now STORED at parse time by
  // lib/korea/parser/run.ts instead of recomputed on read by joining raw_messages (which the 24h purge
  // deletes, losing the link). vacancies/read.ts projects this column (same contact-less/city-less
  // visibility rule) and HIDES offers with neither a contact nor this link from the feed + /count. Run
  // db/backfill_source_link.mts AFTER this to fill existing rows whose raw still survives. Depends on
  // vacancies (draft_0001_init.sql).
  'draft_0023_source_post_url.sql',

  // Mailing is OPT-IN (0024) — ADDITIVE / idempotent (ALTER COLUMN SET DEFAULT). Flips the DEFAULT of
  // subscriptions.notify and subscriptions.digest_enabled from true to false, so a row inserted without
  // naming those columns can never silently opt a user into mail. EXISTING ROWS ARE NOT TOUCHED (no
  // UPDATE): a choice already made stays. Pairs with the server-side change in lib/korea/subscriptions/rw.ts
  // (an ABSENT flag now means OFF) and lib/korea/users/me.ts (a user with no subscription reports OFF).
  // Depends on subscriptions.notify (draft_0001_init.sql) + subscriptions.digest_enabled (draft_0017_digest.sql).
  'draft_0024_notify_default_off.sql',

  // «Не проверено» kill-switch (0025) — ADDITIVE / idempotent (INSERT ... ON CONFLICT DO NOTHING).
  // Seeds config 'hide_unverified' = false (= today's behaviour, nothing changes). When the owner flips
  // it to true, GET /api/raw returns an empty page, POST /api/raw/reveal 404s and GET /api/me reports
  // flags.hide_unverified so the app can hide the tab — all without a deploy. Depends on config
  // (draft_0001_init.sql).
  'draft_0025_hide_unverified.sql',

  // Per-user daily notification cap (0026) — ADDITIVE / idempotent (ADD COLUMN IF NOT EXISTS +
  // SET DEFAULT + guarded CHECK + CREATE INDEX IF NOT EXISTS). Adds subscriptions.notify_daily_cap
  // (integer, NULL = NO LIMIT, new rows default 10) so a person can choose how many notification
  // DMs a day they receive, plus idx_notif_user_sent_at for the per-run "letters already sent
  // today (Asia/Seoul)" count in lib/korea/notify/run.ts. EXISTING ROWS ARE NOT TOUCHED: the column
  // is added WITHOUT a default first (a default on ADD COLUMN would materialise 10 onto every old
  // row) and the default is attached afterwards, so today's subscribers stay unlimited until the
  // owner decides otherwise. Unit is LETTERS, not vacancies (a DM carries up to notify_group_cap
  // offers); the daily digest is a separate channel and is unaffected. MUST be applied BEFORE the
  // matching code deploy (subscriptions/rw.ts + users/me.ts name the column directly). Depends on
  // subscriptions + notifications_sent (draft_0001_init.sql, draft_0010_ads_notify.sql).
  'draft_0026_notify_daily_cap.sql',

  // Inactivity erasure (0027) — ADDITIVE / idempotent (ADD COLUMN IF NOT EXISTS + DROP NOT NULL +
  // CREATE INDEX IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING). Backs the Privacy Policy
  // promise «удаляем данные через 12 месяцев без входа» with a real mechanism: adds
  // users.deleted_at (the erased-account tombstone), makes users.telegram_id NULLABLE (erasure
  // must be able to remove the identifier itself — no row has a NULL today and none can appear
  // until the switch below is turned on), adds idx_users_last_seen_live for the sweep's scan, and
  // seeds the config knobs with the MASTER SWITCH OFF ('inactive_delete_enabled' = false), so
  // applying this file changes NO behaviour and deletes NOTHING. The sweep itself is
  // lib/korea/cleanup/inactive.ts (tail step of cron/cleanup + POST /api/cron/inactive-erase).
  // Apply BEFORE the matching code deploy (the sweep names users.deleted_at directly). Depends on
  // users + config (draft_0001_init.sql, extended by 0003_consent / 0004_referral / 0005_onboarding
  // / 0018_streaks).
  'draft_0027_inactive_erase.sql',

  // Bot inbox anti-spam ledger (0028) — ADDITIVE / idempotent (CREATE TABLE IF NOT EXISTS +
  // CREATE INDEX IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING). Backs the Privacy Policy
  // promise «напиши нам @korea_rabota_bot … ответим в течение 3 рабочих дней»: the webhook now
  // FORWARDS a plain private message to the admins (lib/korea/bot/inbox.ts) instead of dropping
  // it, and this table meters that forwarding — at most user_inbox_per_hour (5) per sender per
  // hour and inbox_global_per_day (200) in 24h across everyone, both seeded here as config keys
  // so they change without a deploy. METADATA ONLY: sender/chat/update ids, message LENGTH and a
  // forwarded flag — the text is never stored (takedown requests carry phone numbers; the message
  // itself lives in the admin's Telegram chat). Rows older than 30 days are purged by
  // cleanup/run.ts. Apply BEFORE the matching code deploy; if the code lands first it degrades to
  // counting bot_updates and still forwards. Depends on config + pgcrypto (draft_0001_init.sql).
  'draft_0028_bot_inbox.sql',

  // Inbox newcomer reserve + owner warning (0029) — ADDITIVE / idempotent (ADD COLUMN IF NOT
  // EXISTS with a default + CREATE INDEX IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING). Adds
  // bot_inbox.kind ('message' | 'reserve' | 'alert') and seeds config
  // 'inbox_newcomer_reserve_per_day' = 30. Closes the hole 007 found in 0028: two flooders could
  // hold the global 200/day window shut, after which a REAL takedown request was answered politely
  // but never forwarded and never stored (we keep no text) — it vanished silently. Now a sender
  // with ZERO forwards in 24h passes over a full window against a small separate ceiling, and the
  // FIRST time the window is exhausted the admins get ONE DM about it (itself metered to once per
  // 24h via an 'alert' marker row). Apply BEFORE the matching code deploy; if the code lands first
  // it retries the pre-0029 claim and behaves exactly like 0028 until this runs. Depends on
  // bot_inbox (draft_0028_bot_inbox.sql) + config (draft_0001_init.sql).
  'draft_0029_inbox_reserve.sql',

  // Scheduled posts + listing images (0030) — ADDITIVE / idempotent (CREATE TABLE IF NOT EXISTS +
  // ADD COLUMN IF NOT EXISTS with safe defaults + CREATE INDEX IF NOT EXISTS + INSERT ... ON
  // CONFLICT DO NOTHING). Backs the owner tool «отложенные публикации»: he DMs the bot /post ONCE
  // (text, or the caption of a photo), confirms a preview, and lib/korea/scheduled/run.ts publishes
  // it at the appointed Seoul time — optionally repeating it, where every repeat is a NEW card that
  // ARCHIVES the previous one (a repeat must never re-date an old card). Adds media_files (image
  // BYTES, so the app serves /api/media/<id> from our own origin — a Telegram file URL carries the
  // bot token and must never reach a browser), scheduled_posts, scheduled_post_runs (PK
  // (schedule_id, run_no) IS the idempotency key: claim first, publish second), user_ads.media_id +
  // user_ads.promo (kind='promo' = a PAID placement labelled «Реклама»: feed only, NEVER a DM), and
  // four scheduled_* config knobs. Applying it changes NO existing behaviour: every current row
  // keeps media_id NULL and promo=false, and nothing is scheduled yet. Apply BEFORE the matching
  // code deploy (the worker names these tables directly); if the code lands first, /post answers an
  // error, the feed/notify keep working (they read promo through to_jsonb, so a missing column is
  // simply "not a promo") and nothing is published. Depends on users + user_ads + config + cities
  // (draft_0001 / 0003 / 0010 / 0020 / 0021).
  'draft_0030_scheduled_posts.sql',

  // Acquisition label (0031) — ADDITIVE / idempotent (ADD COLUMN IF NOT EXISTS + CREATE INDEX IF
  // NOT EXISTS). ONE nullable column users.acq_source: WHERE a NEW user came from, taken from a
  // labelled deep link `?startapp=ads_ru1` / `?start=ads_ru1` (Telegram Ads «URL to promote»).
  // Written ONLY on INSERT — a later visit, another campaign link or a referral link can never
  // overwrite it, and an already-existing user who taps the ad is not counted. Completely separate
  // from the referral graph: an ad visitor gets NO inviter and earns nobody points. Applying it
  // changes NO existing behaviour (every current row stays NULL). Apply BEFORE or AFTER the code
  // deploy — both orders are safe: the auth upsert falls back to the plain (label-less) upsert if
  // the column is missing, and /stats simply omits the block. Depends on users (draft_0001).
  'draft_0031_acq_source.sql',

  // Acquisition ALLOW-LIST (0032) — ADDITIVE / idempotent (INSERT ... ON CONFLICT DO NOTHING +
  // CREATE TABLE IF NOT EXISTS). Closes the hole the legal review found in 0031: the parser only
  // validates the SHAPE of a label, so anyone could put free text into their own row via a public
  // `?startapp=…` tail (and that text survives account erasure), and a label could describe a
  // PERSON (`s_uzbeki` — a special category of personal data) instead of a channel. From now on a
  // label is stored ONLY if it is listed in config 'acq_sources_allowed' (seeded here with the four
  // planned campaigns: ads_ru1/ads_ru2/ads_uz1/ads_uz2); everything else resolves to NULL and the
  // person simply enters unlabelled. Also adds acq_rejects — a per-day COUNT of labels that missed
  // the list (no value, no user: one date + one number), so a typo in the ad cabinet shows up in
  // /stats instead of being silent. FAIL-CLOSED: until this runs the list is empty and NO label is
  // recorded, so apply it BEFORE the ads start. Code: lib/korea/core/acq-source.ts (shared by the
  // Mini App auth path and the bot /start). Depends on config (draft_0001) and, in meaning,
  // users.acq_source (draft_0031).
  'draft_0032_acq_allowlist.sql',
];

const pool = new Pool({ connectionString: url });
try {
  const v = await pool.query('select version() as v');
  console.log('connected:', String(v.rows[0].v).split(',')[0]);
  for (const f of files) {
    const sql = readFileSync(MIG_DIR + f, 'utf8');
    process.stdout.write(`applying ${f} ... `);
    await pool.query(sql);
    console.log('OK');
  }
  const cities = await pool.query('select count(*)::int as n from cities');
  const sources = await pool.query('select count(*)::int as n from sources');
  const config = await pool.query('select count(*)::int as n from config');
  console.log(`VERIFY: cities=${cities.rows[0].n} sources=${sources.rows[0].n} config=${config.rows[0].n}`);
  console.log('MIGRATIONS DONE');
} catch (e) {
  console.error('MIGRATION FAILED:', e && e.message ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
