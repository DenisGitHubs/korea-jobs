// db/peek.mjs — quick read-only snapshot of the live pipeline (raw_messages,
// vacancies). Reads DATABASE_URL(_UNPOOLED) from the local .env — never printed.
//   node db/peek.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from '@neondatabase/serverless';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const envText = readFileSync(join(ROOT, '.env'), 'utf8');
const val = (k) => {
  const m = envText.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : null;
};
const url = val('DATABASE_URL_UNPOOLED') || val('DATABASE_URL');
if (!url) { console.error('no DATABASE_URL'); process.exit(1); }

const pool = new Pool({ connectionString: url });
async function q(label, sql) {
  try { const r = await pool.query(sql); return r.rows; }
  catch (e) { console.log(`  (${label} failed: ${e.message})`); return null; }
}
try {
  const rm = await q('raw total', 'select count(*)::int n from raw_messages');
  const rmByStatus = await q('raw by status', 'select status, count(*)::int n from raw_messages group by status order by n desc');
  const vac = await q('vac total', 'select count(*)::int n from vacancies');
  const vacActive = await q('vac active', 'select count(*)::int n from vacancies where is_active');
  const recent = await q('recent raw', "select r.id, s.username, left(regexp_replace(r.text, '\\s+', ' ', 'g'), 90) as snippet, r.posted_at from raw_messages r left join sources s on s.id = r.source_id order by r.posted_at desc limit 6");

  console.log('=== PIPELINE SNAPSHOT ===');
  console.log('raw_messages total:', rm ? rm[0].n : '?');
  if (rmByStatus) for (const row of rmByStatus) console.log('  status', row.status, '=', row.n);
  console.log('vacancies total:', vac ? vac[0].n : '?', '| active:', vacActive ? vacActive[0].n : '?');
  if (recent && recent.length) {
    console.log('--- recent raw messages ---');
    for (const row of recent) console.log(` [@${row.username ?? '?'}] ${row.snippet ?? ''}`);
  } else {
    console.log('--- no raw messages yet ---');
  }
} finally {
  await pool.end();
}
