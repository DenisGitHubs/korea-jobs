// TEMP read-only: dump raw_messages texts by status to calibrate spam prefilter. Delete after.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from '@neondatabase/serverless';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const envText = readFileSync(join(ROOT, '.env'), 'utf8');
const val = (k) => { const m = envText.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : null; };
const url = val('DATABASE_URL_UNPOOLED') || val('DATABASE_URL');
const pool = new Pool({ connectionString: url });
const q = async (sql) => (await pool.query(sql)).rows;
try {
  const clean = (t) => (t||'').replace(/\s+/g,' ').trim();
  console.log('###### SKIPPED (likely spam/noise) ######');
  const sk = await q(`select left(regexp_replace(text,'\\s+',' ','g'),200) t, reject_reason from raw_messages where status='skipped' order by posted_at desc limit 40`);
  for (const x of sk) console.log(`[${x.reject_reason||'?'}] ${x.t}`);
  console.log('\n\n###### PARSED -> became vacancy (REAL vacancies, must NOT be caught) ######');
  const vv = await q(`select left(regexp_replace(r.text,'\\s+',' ','g'),200) t from raw_messages r where exists(select 1 from vacancies v where v.raw_message_id=r.id) order by r.posted_at desc limit 30`);
  for (const x of vv) console.log(`[VAC] ${x.t}`);
} finally { await pool.end(); }
