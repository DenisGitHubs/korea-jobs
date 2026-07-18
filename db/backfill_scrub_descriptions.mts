// db/backfill_scrub_descriptions.mts — one-off, IDEMPOTENT backfill for the rule #7 money fix.
//
// Why: scrubContacts() (write side, parser/run.ts) baked the redaction into vacancies.description.
// Before the 2026-07-18 fix, rule #7 ate big salary amounts ("2 500 000~3 000 000 вон" ->
// "[скрыто]~[скрыто]"). ~92 live rows carry that damage. This re-derives each active, non-duplicate
// vacancy's description from the ORIGINAL raw_messages.text using the NEW shared scrubber, so the
// backfill can never diverge from what the parser now writes.
//
// Run from the project root (tsx is a devDependency; needed to import the shared .ts scrubber):
//   npx tsx db/backfill_scrub_descriptions.mts
//
// Reads DATABASE_URL_UNPOOLED (fallback DATABASE_URL) from the local .env — never printed.
// Idempotent: only rows whose description actually changes are written; re-running is a no-op.
// Read-only for raw_messages; writes only vacancies.description (+ updated_at) — no schema change.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from '@neondatabase/serverless';
import { scrubContacts } from '../lib/korea/core/scrub.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');

function envVal(text: string, key: string): string | null {
  const m = text.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim() : null;
}

const envText = readFileSync(ENV_PATH, 'utf8');
const url = envVal(envText, 'DATABASE_URL_UNPOOLED') || envVal(envText, 'DATABASE_URL');
if (!url) {
  console.error('FATAL: no DATABASE_URL(_UNPOOLED) in .env');
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
try {
  const v = await pool.query('select version() as v');
  console.log('connected:', String(v.rows[0].v).split(',')[0]);

  // Active, non-duplicate vacancies that still have their raw source text to re-scrub.
  const rows = (
    await pool.query<{ id: string; old_desc: string | null; raw_text: string | null }>(
      `select v.id, v.description as old_desc, r.text as raw_text
         from vacancies v
         join raw_messages r on r.id = v.raw_message_id
        where v.is_active and v.duplicate_of is null and v.raw_message_id is not null`,
    )
  ).rows;

  let scanned = 0;
  let updated = 0;
  let skippedNoText = 0;
  for (const row of rows) {
    scanned++;
    if (row.raw_text == null) {
      skippedNoText++;
      continue;
    }
    const next = scrubContacts(row.raw_text);
    if (next === row.old_desc) continue; // already correct -> idempotent no-op
    await pool.query('update vacancies set description=$1, updated_at=now() where id=$2', [next, row.id]);
    updated++;
  }

  console.log(
    `BACKFILL DONE: scanned=${scanned} updated=${updated} unchanged=${scanned - updated - skippedNoText} skipped_no_raw_text=${skippedNoText}`,
  );
} catch (e) {
  console.error('BACKFILL FAILED:', e && (e as Error).message ? (e as Error).message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
