// db/backfill_city_ids.mts — one-off, IDEMPOTENT backfill of vacancies.city_ids / user_ads.city_ids
// for the MULTI-CITY plan (mirror of lib/korea/parser/run.ts + lib/korea/ads/rw.ts).
//
// Why: draft_0020 seeds city_ids = [city_id] for rows that already have a primary city, but it cannot
// recover the EXTRA cities a post names in its text ("работа в Сеуле и Ансане"). This walks the live
// corpus and enriches city_ids from the original message text + source hint (vacancies) / description
// (user ads), exactly like the parser/ads code now does for NEW rows — so already-published cards gain
// the same multi-city coverage.
//
// Mirrors the runtime detection BYTE-FOR-BYTE via the SHARED lib/korea/cities/detect.ts:
//   * vacancies: {city_id} ∪ detect(original raw text, hint=source title/notes) ∪ detect(source hint)
//   * user ads:  {city_id} ∪ detect(description)
// city_id (the PRIMARY city) is NEVER touched. The write is ADDITIVE — the new set is the UNION of the
// existing city_ids and the freshly computed set, so a row already enriched by the parser only grows,
// never shrinks, and a re-run that computes the same set writes nothing (idempotent).
//
// Run from the project root (tsx is a devDependency), AFTER applying draft_0020:
//   npx tsx db/backfill_city_ids.mts
//
// Reads DATABASE_URL_UNPOOLED (fallback DATABASE_URL) from the local .env — never printed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from '@neondatabase/serverless';
import { buildCityMatcher, detectCitySlugs } from '../lib/korea/cities/detect.js';

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

const BATCH = 500;
const MIN_UUID = '00000000-0000-0000-0000-000000000000';

/** Sorted, de-duplicated union of two uuid string arrays. */
function unionSorted(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

const pool = new Pool({ connectionString: url });
try {
  const v = await pool.query('select version() as v');
  console.log('connected:', String(v.rows[0].v).split(',')[0]);

  // Compile the matcher ONCE from the active cities' aliases (shared with the runtime code).
  const cityRows = (
    await pool.query<{ id: string; slug: string; aliases: unknown }>(
      'select id, slug, aliases from cities where is_active = true',
    )
  ).rows;
  const matcher = buildCityMatcher(cityRows.map((r) => ({ slug: r.slug, aliases: r.aliases })));
  const idBySlug = new Map(cityRows.map((r) => [r.slug, r.id]));
  const slugsToIds = (slugs: string[]): string[] =>
    slugs.map((s) => idBySlug.get(s)).filter((x): x is string => Boolean(x));

  // ── Vacancies: is_active, non-duplicate, with a live raw_message for the ORIGINAL text ──────────
  let vacScanned = 0;
  let vacUpdated = 0;
  let lastVac = MIN_UUID;
  for (;;) {
    const rows = (
      await pool.query<{
        id: string;
        city_id: string | null;
        city_ids: string[] | null;
        text: string | null;
        source_title: string | null;
        source_notes: string | null;
      }>(
        `select v.id, v.city_id, v.city_ids, r.text,
                s.title as source_title, s.notes as source_notes
           from vacancies v
           join raw_messages r on r.id = v.raw_message_id
           left join sources s on s.id = v.source_id
          where v.is_active and v.duplicate_of is null and v.id > $1
          order by v.id
          limit $2`,
        [lastVac, BATCH],
      )
    ).rows;
    if (rows.length === 0) break;
    lastVac = rows[rows.length - 1]!.id;

    for (const row of rows) {
      vacScanned++;
      const srcHint = [row.source_title ?? '', row.source_notes ?? '']
        .map((x) => x.trim())
        .filter(Boolean)
        .join(' — ');
      const detected = [
        ...detectCitySlugs(row.text ?? '', matcher, { hintText: srcHint }),
        ...detectCitySlugs(srcHint, matcher),
      ];
      const computed = [...(row.city_id ? [row.city_id] : []), ...slugsToIds(detected)];
      const existing = Array.isArray(row.city_ids) ? row.city_ids : [];
      const final = unionSorted(existing, computed);
      if (sameSet(final, existing)) continue; // idempotent: nothing new
      await pool.query('update vacancies set city_ids = $1::uuid[] where id = $2::uuid', [final, row.id]);
      vacUpdated++;
    }
  }

  // ── User ads: approved; cities come from the description only ────────────────────────────────
  let adScanned = 0;
  let adUpdated = 0;
  let lastAd = MIN_UUID;
  for (;;) {
    const rows = (
      await pool.query<{ id: string; city_id: string | null; city_ids: string[] | null; description: string | null }>(
        `select a.id, a.city_id, a.city_ids, a.description
           from user_ads a
          where a.status = 'approved' and a.id > $1
          order by a.id
          limit $2`,
        [lastAd, BATCH],
      )
    ).rows;
    if (rows.length === 0) break;
    lastAd = rows[rows.length - 1]!.id;

    for (const row of rows) {
      adScanned++;
      const detected = detectCitySlugs(row.description ?? '', matcher);
      const computed = [...(row.city_id ? [row.city_id] : []), ...slugsToIds(detected)];
      const existing = Array.isArray(row.city_ids) ? row.city_ids : [];
      const final = unionSorted(existing, computed);
      if (sameSet(final, existing)) continue;
      await pool.query('update user_ads set city_ids = $1::uuid[] where id = $2::uuid', [final, row.id]);
      adUpdated++;
    }
  }

  // ── Stats ───────────────────────────────────────────────────────────────────────────────────
  const vacDist = (
    await pool.query<{ k: number; n: number }>(
      `select cardinality(city_ids) as k, count(*)::int as n
         from vacancies where is_active and duplicate_of is null
        group by 1 order by 1`,
    )
  ).rows;
  const adDist = (
    await pool.query<{ k: number; n: number }>(
      `select cardinality(city_ids) as k, count(*)::int as n
         from user_ads where status = 'approved'
        group by 1 order by 1`,
    )
  ).rows;
  const vacNullGained = (
    await pool.query<{ n: number }>(
      `select count(*)::int as n from vacancies
        where is_active and duplicate_of is null and city_id is null and cardinality(city_ids) >= 1`,
    )
  ).rows[0]!.n;
  const adNullGained = (
    await pool.query<{ n: number }>(
      `select count(*)::int as n from user_ads
        where status = 'approved' and city_id is null and cardinality(city_ids) >= 1`,
    )
  ).rows[0]!.n;

  const fmtDist = (rows: { k: number; n: number }[]): string =>
    rows.map((r) => `${r.k}:${r.n}`).join(' ') || '(none)';
  const total = (rows: { k: number; n: number }[]): number => rows.reduce((s, r) => s + r.n, 0);

  console.log(`VACANCIES: scanned=${vacScanned} updated=${vacUpdated} total_active=${total(vacDist)}`);
  console.log(`  city_ids cardinality distribution -> ${fmtDist(vacDist)}`);
  console.log(`  rows with city_id=null that now have >=1 city: ${vacNullGained}`);
  console.log(`USER ADS:  scanned=${adScanned} updated=${adUpdated} total_approved=${total(adDist)}`);
  console.log(`  city_ids cardinality distribution -> ${fmtDist(adDist)}`);
  console.log(`  rows with city_id=null that now have >=1 city: ${adNullGained}`);
  console.log('BACKFILL DONE');
} catch (e) {
  console.error('BACKFILL FAILED:', e && (e as Error).message ? (e as Error).message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
