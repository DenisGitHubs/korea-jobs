// temp scratch — count active cities/regions to size the strict schema enum.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from '@neondatabase/serverless';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const envText = readFileSync(join(ROOT, '.env'), 'utf8');
const val = (k) => { const m = envText.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : null; };
const url = val('DATABASE_URL_UNPOOLED') || val('DATABASE_URL');
const pool = new Pool({ connectionString: url });
const c = (await pool.query('select count(*)::int n from cities where is_active=true')).rows[0].n;
const r = (await pool.query("select count(distinct region_slug)::int n from cities where is_active=true and region_slug is not null")).rows[0].n;
const slugs = (await pool.query('select slug from cities where is_active=true order by sort_order')).rows.map(x=>x.slug);
console.log('active cities:', c, '| regions:', r);
console.log('slugs join length (chars):', slugs.join(',').length);
console.log('slugs:', slugs.join(', '));
await pool.end();
