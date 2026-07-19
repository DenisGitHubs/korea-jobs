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
