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
//   * HOMONYMS — a handful of surface forms name TWO different cities. They are handled by a
//     generalized disambiguation table (HOMONYM_GROUPS) that mirrors the original Gwangju rule:
//     when an ambiguous surface is present in the TEXT, membership among that group's cities is
//     decided by nearby province context (text + hint). EXACTLY ONE member's marker present ->
//     only that city; none or several markers -> ALL members of the group (owner rule: completeness
//     beats precision — a city filter must not silently drop a real post). The groups:
//       - Gwangju : 광주 / Кванджу / Gwangju -> gwangju (Jeolla metro) vs gwangju_gyeonggi (Gyeonggi).
//                   gwangju_gyeonggi has NO aliases in the seed (only this table emits it).
//       - Goseong : 고성 / Goseong / Косон -> goseong_gangwon vs goseong_gyeongnam. The SHARED hangul
//                   & latin sit on BOTH rows; the ambiguous RU (косон) is NOT a seed alias.
//       - Йончхон : ру «йончхон/ёнчхон» -> yeoncheon (연천, Gyeonggi) vs yeongcheon (영천, Gyeongbuk).
//                   Their hangul & latin DIFFER (연천/yeoncheon vs 영천/yeongcheon) so those stay 1:1
//                   seed aliases; only the RU surface is ambiguous and routed here.
//       - Кочхан  : ру «кочхан» -> geochang (거창, Gyeongnam) vs gochang (고창, Jeonbuk). Same shape:
//                   hangul & latin are 1:1 aliases, only the RU surface is routed here.
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

// A few CITY names are also the PREFIX of a PROVINCE name that ads write hyphenated: "Кёнсан" (the
// city Gyeongsan) vs "Кёнсан-Пукто/Намдо" (the province), "Чхунчхон" (the city Chuncheon) vs
// "Чхунчхон-Пукто/Намдо" (the province). The hyphen otherwise reads as a right word boundary, so the
// bare city alias would fire on the province mention. This guard, appended to a CYRILLIC city alias,
// rejects an immediately following province tail ("[-\s]?(пукто|намдо)"). The standalone city and its
// declensions still match ("Кёнсан завод", "в Кёнсане"). Province-context MARKERS are compiled with
// provinceGuard=false — for them, matching that tail is exactly the intent.
// The province tail must be a WHOLE token: "намдо" as a bare suffix is a province, but "намдо…" that
// continues into a letter is a different word — e.g. "Инчхон Намдонг" (남동, Namdong-gu, a district of
// Incheon) must NOT be swallowed. So require the tail to be followed by a NON-letter.
const PROVINCE_TAIL_GUARD = '(?![-\\s]?(?:пукто|намдо)(?![а-яёa-z]))';

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
function compileToken(token: string, provinceGuard = true): (t: string) => boolean {
  if (HANGUL_RE.test(token)) {
    const needle = token;
    return (t) => t.includes(needle);
  }
  // Cyrillic aliases get an OPTIONAL closed-list case ending before the right boundary (declensions);
  // Latin aliases keep the plain boundary. Both keep the alphabet-aware left boundary. A Cyrillic
  // CITY alias also gets the province-tail guard (see PROVINCE_TAIL_GUARD); markers opt out.
  const isCyrillic = CYRILLIC_RE.test(token);
  const suffix = isCyrillic ? CYRILLIC_CASE_SUFFIX : '';
  const guard = isCyrillic && provinceGuard ? PROVINCE_TAIL_GUARD : '';
  const re = new RegExp(BOUNDARY_L + escapeRegex(token) + guard + suffix + BOUNDARY_R, 'iu');
  return (t) => re.test(t);
}

// ── Homonym disambiguation table (module-level, compiled once) ─────────────────────────────────
// A group fires when ANY of its `surfaces` is present in the TEXT. Then each member's `markers`
// (province context) are tested against TEXT + HINT: exactly one member matched -> only that city;
// none / several matched -> ALL members. See the header for the four groups and why.

/** Compile a list of raw surface/marker forms into presence testers (normalized first). Homonym
 * forms opt OUT of the province-tail guard: a province marker like "Кёнсан-Пукто" MUST be matchable. */
function compileForms(forms: string[]): Array<(t: string) => boolean> {
  return forms.map((f) => compileToken(normalizeText(f), false));
}

interface HomonymMember {
  slug: string;
  markers: Array<(t: string) => boolean>;
}
interface HomonymGroup {
  surfaces: Array<(t: string) => boolean>;
  members: HomonymMember[];
}

// Province context markers (ru + en + ko forms). Deliberately broad; only ever consulted when an
// ambiguous surface already fired, so a stray marker cannot add a city on its own.
const MK_GYEONGGI = ['경기', 'gyeonggi', 'кёнги', 'кёнгидо'];
const MK_GANGWON = ['강원', 'gangwon', 'канвон', 'канвондо', 'кангвон'];
const MK_GYEONGNAM = ['경남', '경상', 'gyeongnam', 'gyeongsang', 'кёнсан', 'кённам'];
const MK_GYEONGBUK = ['경북', '경상', 'gyeongbuk', 'gyeongsang', 'кёнсан', 'кёнбук'];
const MK_JEOLLA = ['전라', '전북', '호남', '광역시', 'jeolla', 'jeonbuk', 'honam', 'чолла', 'хонам'];
const MK_METRO = ['전라', '호남', '광역시', 'jeolla', 'honam', 'чолла', 'хонам'];

const HOMONYM_GROUPS: HomonymGroup[] = [
  {
    surfaces: compileForms(['광주', 'кванджу', 'кванчжу', 'gwangju', 'kwangju']),
    members: [
      { slug: 'gwangju', markers: compileForms(MK_METRO) },
      { slug: 'gwangju_gyeonggi', markers: compileForms(MK_GYEONGGI) },
    ],
  },
  {
    surfaces: compileForms(['고성', 'goseong', 'косон']),
    members: [
      { slug: 'goseong_gangwon', markers: compileForms(MK_GANGWON) },
      { slug: 'goseong_gyeongnam', markers: compileForms(MK_GYEONGNAM) },
    ],
  },
  {
    surfaces: compileForms(['йончхон', 'ёнчхон']),
    members: [
      { slug: 'yeoncheon', markers: compileForms(MK_GYEONGGI) },
      { slug: 'yeongcheon', markers: compileForms(MK_GYEONGBUK) },
    ],
  },
  {
    surfaces: compileForms(['кочхан']),
    members: [
      { slug: 'geochang', markers: compileForms(MK_GYEONGNAM) },
      { slug: 'gochang', markers: compileForms(MK_JEOLLA) },
    ],
  },
];

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

  // Homonym disambiguation. For every group whose ambiguous surface is present in the TEXT, decide
  // which member cities belong by the TEXT+HINT province context, then force the result's membership
  // for that group's slugs to EXACTLY the decided set: base matching may have added a member via an
  // ambiguous alias (Gwangju/Goseong) — that is corrected here; members added via an UNAMBIGUOUS
  // alias only ever coincide with the decided set for realistic inputs.
  let ctx: string | null = null;
  for (const group of HOMONYM_GROUPS) {
    if (!group.surfaces.some((t) => t(norm))) continue;
    if (ctx === null) ctx = normalizeText(`${text ?? ''} \n ${opts?.hintText ?? ''}`);
    const matched = group.members.filter((m) => m.markers.some((t) => t(ctx as string)));
    const decided = new Set((matched.length === 1 ? matched : group.members).map((m) => m.slug));
    for (const m of group.members) {
      if (decided.has(m.slug) && matcher.knownSlugs.has(m.slug)) result.add(m.slug);
      else result.delete(m.slug);
    }
  }

  return [...result];
}
