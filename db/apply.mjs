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
  // Phase 1 v2 (0003) — order matters: vacancy_fields creates the visa_type /
  // placement_fee enums that subscription_filters and user_ads depend on.
  'draft_0003_vacancy_fields.sql',
  'draft_0003_moderation.sql',
  'draft_0003_consent.sql',
  'draft_0003_takedown.sql',
  'draft_0003_subscription_filters.sql',
  'draft_0003_user_ads.sql',
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
