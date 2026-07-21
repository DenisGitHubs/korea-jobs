// lib/korea/cities/detect.ts
//
// Deterministic, DB-free city detection from free text. Given the cities table's `aliases`
// (a jsonb array of lowercased ru/ko/en/translit spellings), buildCityMatcher() compiles ONE
// reusable matcher (per batch), and detectCitySlugs() returns the set of city SLUGS a message
// mentions. This is the multi-city counterpart of the AI's single best-guess city_slug: the
// parser/backfill UNION the AI pick, this text scan, and the source-hint scan into vacancies.city_ids.
//
// WHY a hand-written matcher (not the model): the model already returns ONE primary city; the
// EXTRA cities in a multi-city post ("работа в Сеуле и Ансане") are cheap to recover from the
// text without more tokens. Precision matters — a false city would surface a card under a wrong
// filter — so matching is boundary-aware, not a naive substring scan.
//
// SECURITY: aliases come FROM THE DB — they are DATA, never a regex. Every alias is escaped
// (escapeRegex) before it is compiled, so a pathological alias can never inject regex syntax.
//
// MATCHING RULES (owner/Sanya-approved):
//   * Normalize the text first: strip zero-width chars, collapse whitespace, lowercase. Punctuation
//     is KEPT (it is part of the word boundaries below).
//   * Latin / Cyrillic aliases match on ALPHABET-AWARE word boundaries — (^|[^а-яёa-z0-9]) on the
//     left and (?![а-яёa-z0-9]) on the right, flags 'iu'. We do NOT use \b: \b treats Cyrillic as
//     non-word, so "\bпусан\b" is unreliable. This keeps "ансан" out of "квансан"/"касание".
//   * RUSSIAN DECLENSIONS (Cyrillic aliases ONLY, owner/orchestrator-approved): aliases are seeded
//     nominative, but ads decline them ("в Ансане", "из Ансана", "Сеулом"). So for a Cyrillic alias
//     the right boundary allows ONE optional case ending from a CLOSED list first:
//     alias(?:а|у|е|ом)?(?![а-яёa-z0-9]). The list is intentionally tiny — declensions match, but a
//     non-listed ending still fails the boundary ("пусанский", "осанку" -> NO match). LATIN and
//     HANGUL aliases are UNCHANGED (no case suffix): Latin keeps the plain boundary, Hangul substring.
//   * Hangul aliases match as a plain SUBSTRING (no boundaries): Korean does not space-separate the
//     way the boundary classes assume, so "서울시" must still yield 서울.
//   * Gwangju is a HOMONYM — 광주 / Кванджу / Gwangju / Kwangju names TWO different cities (the
//     Jeolla metropolitan city `gwangju` and the Gyeonggi city `gwangju_gyeonggi`). The seed gives
//     gwangju_gyeonggi NO aliases on purpose, so a bare surface match would only ever hit the metro;
//     here we disambiguate by nearby context (text + hint): a Gyeonggi marker -> only gwangju_gyeonggi;
//     a Jeolla/Honam/metropolitan marker -> only the metro; neither (or both) -> BOTH slugs (owner
//     rule: completeness beats precision — a city filter should not silently drop a real Gwangju post).
//   * Чонджу->jeonju and Чхонджу->cheongju are 1:1 by the seed aliases (NOT treated as ambiguous here).

/** A single city's slug + its raw aliases (jsonb array from the DB; validated defensively). */
export interface CityAliasInput {
  slug: string;
  aliases: unknown;
}

interface CompiledAlias {
  slug: string;
  test: (normText: string) => boolean;
}

export interface CityMatcher {
  aliases: CompiledAlias[];
  /** Every slug the matcher knows about — gates which disambiguation slugs may be emitted. */
  knownSlugs: Set<string>;
}

// Zero-width + variation selectors to strip before matching (ZWSP/ZWNJ/ZWJ/BOM/VS15/VS16). Built
// from explicit \u escapes so NO literal invisible code point lives in this source (same discipline
// as parser/text-clean.ts — invisibles are impossible to review or diff safely). A zero-width char
// wedged inside a Hangul word would otherwise defeat the substring scan.
const ZERO_WIDTH_RE = new RegExp('[\\u200B\\u200C\\u200D\\uFEFF\\uFE0E\\uFE0F]', 'g');

// Any Hangul: syllables (AC00–D7A3), conjoining Jamo (1100–11FF), compatibility Jamo (3130–318F),
// Jamo Extended-A (A960–A97F) and Syllables-extended (D7B0–D7FF). An alias with ANY of these is
// treated as Korean -> substring match; otherwise it is latin/cyrillic -> boundary. \u escapes only.
const HANGUL_RE = new RegExp('[\\u1100-\\u11FF\\u3130-\\u318F\\uA960-\\uA97F\\uAC00-\\uD7A3\\uD7B0-\\uD7FF]');

// Alphabet-aware boundaries (see header). 'iu' flags; the classes cover Latin a-z, digits, and
// Cyrillic а-я + ё. Under 'i' the class also excludes A-Z / uppercase Cyrillic, so an adjacent
// uppercase letter still counts as a "word" char (defensive — the text is lowercased anyway).
const BOUNDARY_L = '(?:^|[^а-яёa-z0-9])';
const BOUNDARY_R = '(?![а-яёa-z0-9])';

// Cyrillic aliases are seeded in the NOMINATIVE, but Russian ads decline them ("в Ансане", "из
// Ансана", "Сеулом"). For CYRILLIC aliases only, allow ONE optional case ending from a CLOSED list
// before the right boundary. The list is deliberately tiny so it stays precise: real declensions
// match, while a non-listed ending keeps the word out ("пусанский", "пусантик" still fail the
// boundary because "ский"/"тик" are not in the list). Latin/Hangul aliases NEVER get this suffix.
const CYRILLIC_CASE_SUFFIX = '(?:а|у|е|ом)?';
// True when an alias contains any Cyrillic letter (full block) -> it earns CYRILLIC_CASE_SUFFIX.
const CYRILLIC_RE = new RegExp('[\\u0400-\\u04FF]');

/** Escape every regex metacharacter so a DB-sourced alias is matched LITERALLY (never as a pattern). */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip zero-width, collapse whitespace, lowercase; KEEP punctuation. Idempotent, null-safe. */
function normalizeText(s: string): string {
  return (s ?? '').replace(ZERO_WIDTH_RE, '').replace(/\s+/g, ' ').toLowerCase().trim();
}

/**
 * Compile ONE normalized token into a presence tester. Hangul -> substring; latin/cyrillic ->
 * boundary regex (compiled once, reused; no 'g' flag so .test() is stateless across texts).
 */
function compileToken(token: string): (t: string) => boolean {
  if (HANGUL_RE.test(token)) {
    const needle = token;
    return (t) => t.includes(needle);
  }
  // Cyrillic aliases get an OPTIONAL closed-list case ending before the right boundary (declensions);
  // Latin aliases keep the plain boundary. Both keep the alphabet-aware left boundary.
  const suffix = CYRILLIC_RE.test(token) ? CYRILLIC_CASE_SUFFIX : '';
  const re = new RegExp(BOUNDARY_L + escapeRegex(token) + suffix + BOUNDARY_R, 'iu');
  return (t) => re.test(t);
}

// ── Gwangju homonym context (module-level, compiled once) ─────────────────────────────────────
// Surface forms that name a "Gwangju" (either city). Presence is checked in the TEXT only.
const GWANGJU_SURFACE = ['광주', 'кванджу', 'gwangju', 'kwangju'].map(normalizeText);
// Context markers, checked in TEXT + HINT. Gyeonggi -> the Seoul-area city; Jeolla/Honam/metropolitan
// -> the metro. 광역시 = "metropolitan city" (only the metro carries that title).
const GYEONGGI_MARKERS = ['경기', 'gyeonggi'].map(normalizeText);
const METRO_MARKERS = ['전라', '호남', '광역시'].map(normalizeText);

const GWANGJU_SURFACE_TESTERS = GWANGJU_SURFACE.map(compileToken);
const GYEONGGI_TESTERS = GYEONGGI_MARKERS.map(compileToken);
const METRO_TESTERS = METRO_MARKERS.map(compileToken);

const GWANGJU_METRO = 'gwangju';
const GWANGJU_GYEONGGI = 'gwangju_gyeonggi';

/**
 * Compile a reusable matcher from the active cities' aliases. Build ONCE per batch, then call
 * detectCitySlugs for every message — the regexes are shared, so this is cheap per row.
 */
export function buildCityMatcher(cities: CityAliasInput[]): CityMatcher {
  const aliases: CompiledAlias[] = [];
  const knownSlugs = new Set<string>();
  for (const c of cities) {
    if (!c || typeof c.slug !== 'string' || c.slug === '') continue;
    knownSlugs.add(c.slug);
    const list = Array.isArray(c.aliases) ? c.aliases : [];
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const alias = normalizeText(raw);
      if (!alias) continue;
      aliases.push({ slug: c.slug, test: compileToken(alias) });
    }
  }
  return { aliases, knownSlugs };
}

/**
 * Detect every city SLUG mentioned in `text`. `opts.hintText` (e.g. the source channel title/notes)
 * is used ONLY as extra CONTEXT for the Gwangju homonym — it never adds a city on its own here (the
 * caller scans the hint text separately when it wants hint cities). Returns a de-duplicated slug array.
 */
export function detectCitySlugs(
  text: string,
  matcher: CityMatcher,
  opts?: { hintText?: string },
): string[] {
  const norm = normalizeText(text);
  const result = new Set<string>();
  for (const a of matcher.aliases) {
    if (a.test(norm)) result.add(a.slug);
  }

  // Gwangju disambiguation. Base matching can only ever have added the metro slug (gwangju_gyeonggi
  // has no aliases), so when a Gwangju surface form is present in the TEXT, decide membership by the
  // TEXT+HINT context and rewrite the metro/gyeonggi pair accordingly.
  if (GWANGJU_SURFACE_TESTERS.some((t) => t(norm))) {
    const ctx = normalizeText(`${text ?? ''} \n ${opts?.hintText ?? ''}`);
    const gyeonggi = GYEONGGI_TESTERS.some((t) => t(ctx));
    const metro = METRO_TESTERS.some((t) => t(ctx));
    // Drop the metro slug added by base matching; re-add exactly the decided slug(s). We never DROP
    // gwangju_gyeonggi (future-proof: were it ever given an explicit alias, that match should stand).
    result.delete(GWANGJU_METRO);
    let decided: string[];
    if (gyeonggi && !metro) decided = [GWANGJU_GYEONGGI];
    else if (metro && !gyeonggi) decided = [GWANGJU_METRO];
    else decided = [GWANGJU_METRO, GWANGJU_GYEONGGI]; // no context OR conflicting context -> both
    for (const s of decided) if (matcher.knownSlugs.has(s)) result.add(s);
  }

  return [...result];
}
