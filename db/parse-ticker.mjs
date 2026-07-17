// db/parse-ticker.mjs — realtime driver. Every ~60s asks the backend to run one AI
// extraction batch (POST /api/cron/parse). A no-op when nothing is pending (the
// server returns processed:0 without calling Claude), so it's cheap to run always.
// Reads APP_URL + CRON_SECRET from the local .env. Run: node db/parse-ticker.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = readFileSync(join(ROOT, '.env'), 'utf8');
const val = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : null; };
const base = (val('APP_URL') || 'https://korea-jobs-omega.vercel.app').replace(/\/+$/, '');
const secret = val('CRON_SECRET');
const INTERVAL_MS = 60_000;

async function tick() {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  try {
    const r = await fetch(base + '/api/cron/parse', { method: 'POST', headers: { Authorization: 'Bearer ' + secret } });
    const body = await r.json().catch(() => ({}));
    console.log(`${stamp}  parse -> ${JSON.stringify(body)}`);
  } catch (e) {
    console.log(`${stamp}  tick failed: ${e instanceof Error ? e.message : e}`);
  }
}

console.log(`parse-ticker: POST ${base}/api/cron/parse every ${INTERVAL_MS / 1000}s`);
await tick();
setInterval(tick, INTERVAL_MS);
