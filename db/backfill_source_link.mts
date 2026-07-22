// db/backfill_source_link.mts — one-off, IDEMPOTENT backfill of vacancies.source_post_url (draft_0023).
//
// Why: draft_0023 adds the persisted original-post link column, and the parser now fills it on INSERT —
// but EXISTING rows have it NULL. This recovers the link for every vacancy whose raw_messages row still
// survives, using the SAME formula as the parser / the old read-side CASE:
//   https://t.me/<sources.username>/<raw_messages.tg_message_id>
// A row whose raw was already purged (24h cleanup) simply stays NULL and is unrecoverable here — that is
// exactly why the parser now persists it going forward.
//
// SCOPE: only fills where source_post_url IS NULL (idempotent — a re-run writes nothing new) and never
// touches city_id / city_ids / contact_* / any other column. It is purely a SET of the one new column.
//
// Run from the project root, AFTER applying draft_0023:
//   npx tsx db/backfill_source_link.mts
//
// Reads DATABASE_URL_UNPOOLED (fallback DATABASE_URL) from the local .env — never printed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from '@neondatabase/serverless';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');

function envVal(text: string, key: string): string | null {
  const m = text.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? (m[1] ?? '').trim() : null;
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

  // Snapshot BEFORE (active, non-duplicate rows only — that is the feed surface the hide-filter acts on).
  const before = (
    await pool.query<{ total: number; with_link: number; null_link: number; dead_end: number }>(
      `select count(*)::int as total,
              count(*) filter (where source_post_url is not null)::int as with_link,
              count(*) filter (where source_post_url is null)::int as null_link,
              count(*) filter (where source_post_url is null and contact_normalized is null)::int as dead_end
         from vacancies where is_active and duplicate_of is null`,
    )
  ).rows[0]!;

  // The backfill itself — set-based, single statement. Fill ONLY where the link is still NULL and the
  // raw row + a channel username + a message id all survive. `is_active`-agnostic (harmless to fill a
  // dark row too), but the raw generally only survives for active cards, so this naturally targets them.
  const filled = (
    await pool.query<{ id: string }>(
      `update vacancies v
          set source_post_url = 'https://t.me/' || s.username || '/' || rm.tg_message_id::text
         from raw_messages rm
         join sources s on s.id = rm.source_id
        where v.raw_message_id = rm.id
          and v.source_post_url is null
          and s.username is not null and s.username <> ''
          and rm.tg_message_id is not null
        returning v.id`,
    )
  ).rowCount;

  // Snapshot AFTER (same active, non-duplicate surface).
  const after = (
    await pool.query<{ total: number; with_link: number; null_link: number; dead_end: number }>(
      `select count(*)::int as total,
              count(*) filter (where source_post_url is not null)::int as with_link,
              count(*) filter (where source_post_url is null)::int as null_link,
              count(*) filter (where source_post_url is null and contact_normalized is null)::int as dead_end
         from vacancies where is_active and duplicate_of is null`,
    )
  ).rows[0]!;

  console.log(`FILLED source_post_url on ${filled} vacancies (raw still present).`);
  console.log('ACTIVE, non-duplicate vacancies:');
  console.log(`  total:              ${before.total} -> ${after.total}`);
  console.log(`  with a link:        ${before.with_link} -> ${after.with_link}`);
  console.log(`  link still NULL:    ${before.null_link} -> ${after.null_link}`);
  console.log(`  DEAD ENDS (no contact AND no link, hidden from the feed): ${before.dead_end} -> ${after.dead_end}`);
  console.log('BACKFILL DONE');
} catch (e) {
  console.error('BACKFILL FAILED:', e && (e as Error).message ? (e as Error).message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
