// db/backfill_raw_text_hash.mts — one-off, IDEMPOTENT backfill for draft_0009_raw_text_hash.sql.
//
// Why: the parser now dedups byte-for-byte reposts BEFORE the AI call by comparing a normalized
// text_hash (see lib/korea/parser/texthash.ts). New rows get it lazily from the parser, but the
// existing raw_messages corpus has text_hash = NULL. This walks every un-hashed row and fills it.
//
// The hash is computed in JS with the SAME shared function the parser uses, so the backfill can
// never diverge from what the running parser writes. Short/empty texts hash to null and are left
// null (correctly "not deduped").
//
// Run from the project root (tsx is a devDependency; needed to import the shared .ts module):
//   npx tsx db/backfill_raw_text_hash.mts
//
// Reads DATABASE_URL_UNPOOLED (fallback DATABASE_URL) from the local .env — never printed.
// Idempotent: keyset-paginates over rows WHERE text_hash IS NULL, so a re-run only re-touches the
// still-null (short/empty) tail and writes nothing new. Additive — no schema change.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from '@neondatabase/serverless';
import { textHash } from '../lib/korea/parser/texthash.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const BATCH = 1000;

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

  // Keyset pagination by id over the un-hashed rows. We advance lastId monotonically, so rows we
  // hash drop out of the predicate without ever being revisited in this run; short-text rows stay
  // null and are simply passed (id already behind the cursor).
  let lastId = '00000000-0000-0000-0000-000000000000';
  let scanned = 0;
  let hashed = 0;
  let shortOrEmpty = 0;
  for (;;) {
    const rows = (
      await pool.query<{ id: string; text: string | null }>(
        `select id, text from raw_messages
          where text_hash is null and id > $1::uuid
          order by id
          limit $2`,
        [lastId, BATCH],
      )
    ).rows;
    if (rows.length === 0) break;
    for (const row of rows) {
      lastId = row.id;
      scanned++;
      const h = textHash(row.text);
      if (h == null) {
        shortOrEmpty++;
        continue;
      }
      await pool.query('update raw_messages set text_hash=$1 where id=$2::uuid', [h, row.id]);
      hashed++;
    }
  }

  console.log(`BACKFILL DONE: scanned=${scanned} hashed=${hashed} short_or_empty=${shortOrEmpty}`);
} catch (e) {
  console.error('BACKFILL FAILED:', e && (e as Error).message ? (e as Error).message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
