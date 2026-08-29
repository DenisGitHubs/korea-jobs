// db/parse-ticker.mjs — the local driver for the backend's scheduled work.
//
// WHAT CHANGED AND WHY (2026-08-29). This used to POST /api/cron/parse every 60 SECONDS. A Neon
// compute sleeps only after 5 minutes of complete silence, so a once-a-minute ping alone is enough
// to keep the database awake 24/7 — 1440 wake-ups a day, each buying a minimum of five awake
// minutes. Together with the reader's per-message ingest that burned 110.26 of 100 CU-hours by
// Aug 19; the product was dark for everybody until the billing period reset.
//
// Now:
//   * the interval is 15 MINUTES by default (PARSE_TICK_MINUTES), not one;
//   * ticks land on WALL-CLOCK boundaries (:00/:15/:30/:45) — the same instants a `*/15` crontab
//     and the reader's own window use, so they share ONE awake window instead of waking the
//     database at three different minutes;
//   * one call does everything: POST /api/cron/tick runs parse + notify + publications + digest +
//     retention + referral credits inside one 45s budget. If the deployed backend does not know
//     that route yet (404), this falls back to /api/cron/parse for that tick and says so.
//
// Reads APP_URL + CRON_SECRET from the local .env (process.env wins). Run: node db/parse-ticker.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let env = '';
try {
  env = readFileSync(join(ROOT, '.env'), 'utf8');
} catch {
  env = ''; // no local .env — everything must then come from the environment
}
const val = (k) => {
  if (process.env[k]) return String(process.env[k]).trim();
  const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : null;
};

const base = (val('APP_URL') || 'https://korea-jobs-omega.vercel.app').replace(/\/+$/, '');
const secret = val('CRON_SECRET');

/** Minutes between ticks. Clamped to 1..60; keep it equal to the reader's INGEST_BATCH_MINUTES so
 *  both land in the same wake-up. */
const minutes = Math.min(60, Math.max(1, Math.trunc(Number(val('PARSE_TICK_MINUTES')) || 15)));
const INTERVAL_MS = minutes * 60_000;

/** The combined pass. Overridable (CRON_PATH=/api/cron/parse) when only parsing is wanted. */
const PATH = val('CRON_PATH') || '/api/cron/tick';
const LEGACY_PATH = '/api/cron/parse';

/** Milliseconds to the next wall-clock multiple of the interval — the same rule the reader uses
 *  (collector/src/schedule.ts). Exactly on a boundary it waits a full interval, never zero. */
function msUntilNextBoundary(nowMs, intervalMs) {
  return intervalMs - (((nowMs % intervalMs) + intervalMs) % intervalMs);
}

const stamp = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 19);

async function call(path) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

async function tick() {
  try {
    let used = PATH;
    let { status, body } = await call(PATH);
    if (status === 404 && PATH !== LEGACY_PATH) {
      // The deployed backend predates the combined pass. Keep the pipeline running, and be loud
      // about WHY — this must never be mistaken for the tick simply working.
      console.log(`${stamp()}  ${PATH} -> 404; deployed backend has no combined tick yet, falling back`);
      used = LEGACY_PATH;
      ({ status, body } = await call(LEGACY_PATH));
    }
    // Name the path that ACTUALLY answered: a line saying /api/cron/tick [200] after a silent
    // fallback would read as "the combined pass ran" when only parsing did.
    console.log(`${stamp()}  ${used} [${status}] -> ${JSON.stringify(body)}`);
  } catch (e) {
    console.log(`${stamp()}  tick failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Re-arm from the CURRENT time after each run, so a slow tick delays the next window instead of
 *  queueing up catch-up runs. */
function arm() {
  const wait = msUntilNextBoundary(Date.now(), INTERVAL_MS);
  setTimeout(async () => {
    await tick();
    arm();
  }, wait);
  return new Date(Date.now() + wait);
}

if (!secret) {
  console.log('parse-ticker: WARNING — CRON_SECRET is empty; every tick will come back 401');
}
const first = arm();
console.log(
  `parse-ticker: POST ${base}${PATH} every ${minutes} min, on the wall-clock boundary.\n` +
    `  First run at ${stamp(first)} UTC. Nothing is sent right now on purpose: an off-boundary call\n` +
    `  would open its own 5-minute database window right next to the one the schedule is about to open.`,
);
