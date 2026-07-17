// db/run-parse-local.ts — run the REAL parser locally against the shared DB with
// the known-good local key. Diagnoses the code path AND actually turns pending
// raw_messages into vacancies. Run: npx tsx db/run-parse-local.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = readFileSync(join(ROOT, '.env'), 'utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
// The serverless db module reads DATABASE_URL; make sure it points at the DB.
if (!process.env.DATABASE_URL && process.env.DATABASE_URL_UNPOOLED) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;
}

const { runParse } = await import('../lib/korea/parser/run.js');
try {
  const r = await runParse();
  console.log('runParse result:', JSON.stringify(r));
} catch (e) {
  console.log('runParse THREW:', e instanceof Error ? (e.stack ?? e.message) : String(e));
}
process.exit(0);
