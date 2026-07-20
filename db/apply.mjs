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
