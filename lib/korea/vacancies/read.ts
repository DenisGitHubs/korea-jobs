// lib/korea/vacancies/read.ts
//
// The vacancy feed + detail + contact reveal + SAVED (bookmarks). Matches the mini-app
// contract (app/src/shared/types/api.ts) exactly.
//
// SAVED (Phase 3a): a private per-user bookmark list is the SAME feed projection scoped to
// the caller's saved_vacancies / saved_ads rows (GET /api/saved), plus a heart toggle
// (POST|DELETE /api/vacancies/:id/save). Every feed/detail row carries `is_saved` (a LEFT
// JOIN of the caller's bookmarks) so the card can render its heart state. Nothing new is
// exposed: the saved list uses the same `toView` projection (contacts stay hidden behind
// has_contact / the /contact endpoint); only the scope changes to auth.user.id.
//
// The feed is the UNION of scraped vacancies and APPROVED, unexpired user_ads, paged
// by a single cursor over (posted_at, id). Each row carries source_kind so the client
// can tell them apart; a user ad's posted_at is greatest(created_at, bumped_at).
//
// SECURITY (007): explicit column projection — NEVER expose source_id /
// raw_message_id / content_hash / internal ids. The feed and detail carry
// `has_contact` but not the value; the phone/handle is returned ONLY by /contact.
//   * The parser is told to keep contacts out of title/description/employer, and
//     scrubContacts() here strips any that slip through (defense in depth).
//   * /contact enforces a per-user daily cap (shared across scraped + user ads) and
//     records the reveal, so one account can't scrape every employer's phone.
//   * source_post_url (detail only): fall back to the PUBLIC original-post link
//     https://t.me/<sources.username>/<tg_message_id> for a scraped offer when EITHER it has
//     NO direct contact (the contact ladder) OR it has NO city (cardinality(city_ids)=0 — the
//     user can't tell where the job is, so let them open the source post for context / to ask
//     the author). It leaks ONLY the source username (owner-approved) — never tg_chat_id /
//     sender_id / any internal id — and is NOT gated by the reveal cap (a public post link).
// Dynamic filter fields are whitelisted; ids are validated before hitting the DB.
//
// Filter matching is PERMISSIVE for rare attributes (Sanya/Roma K2): a filter excludes
// only rows that EXPLICITLY contradict it; "not stated"/empty always passes.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, queryParam } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { getConfigNumber, getConfigString } from '../config.js';
import { WORK_TYPES, VISA_TYPES } from '../parser/prompt.js';
import { scrubContacts } from '../core/scrub.js';
import { recordReferralActivation } from '../referral/accrue.js';
import { bumpOpenStreakBestEffort } from '../streaks/update.js';

const PAGE_SIZE = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORK_TYPE_SET = new Set<string>(WORK_TYPES);
const VISA_TYPE_SET = new Set<string>(VISA_TYPES);
const FRESHNESS_DAYS = new Set([1, 3, 7, 14]);

interface Row {
  id: string;
  city_slug: string | null;
  city_name: unknown;
  // MULTI-CITY: the FULL city set of this offer, main city first then the rest by slug (built in SQL
  // by json_agg over city_ids; see citiesAggSql). Same {slug,name} shape as the single `city` field.
  cities: unknown;
  region_slug: string | null;
  work_type: string;
  gender: string;
  salary_text: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_period: string | null;
  employer: string | null;
  description: string | null;
  posted_at: string;
  has_contact: boolean;
  visa_types: string[] | null;
  placement_fee: string;
  has_housing: boolean | null;
  has_meals: boolean | null;
  source_kind: string;
  repost: boolean;
  is_saved: boolean;
  // Whether THIS caller has already revealed the contact for this card — mirrors is_saved, but
  // sourced from the reveal audit (contact_reveals for scraped, ad_contact_reveals for user ads).
  // Lets the card show "уже смотрел контакт". Only the caller's own reveal is ever exposed.
  is_revealed: boolean;
  // Only populated by the saved feed (savedUnionSql) — the bookmark's created_at, used as
  // the saved-list cursor. Absent (undefined) on the main feed / detail rows.
  saved_at?: string;
  // Deep link to the ORIGINAL channel post, computed ONLY by the detail query
  // (vacancyDetail, scraped branch) and ONLY when the offer has NO direct contact OR NO city
  // (city_ids empty) AND its source channel has a public username. Absent (undefined) on the
  // feed / saved / user-ad projections, where toView emits null. Never carries anything but
  // the source username.
  source_post_url?: string | null;
}

/** DB row -> VacancyView (feed/detail projection; never includes `contact`). */
function toView(r: Row) {
  return {
    id: r.id,
    city: r.city_slug ? { slug: r.city_slug, name: r.city_name } : null,
    // MULTI-CITY (contract): the full city list, main city first. Same {slug,name} items as `city`
    // (kept for compat). Empty [] when the offer has no cities. The SQL guarantees the ordering.
    cities: Array.isArray(r.cities) ? r.cities : [],
    region_slug: r.region_slug ?? null,
    work_type: r.work_type,
    gender: r.gender,
    salary_text: r.salary_text ?? null,
    salary_min: r.salary_min ?? null,
    salary_max: r.salary_max ?? null,
    salary_period: r.salary_period ?? null,
    employer: scrubContacts(r.employer ?? null),
    description: scrubContacts(r.description ?? '') ?? '',
    posted_at: new Date(r.posted_at).toISOString(),
    has_contact: r.has_contact === true,
    visa_types: Array.isArray(r.visa_types) ? r.visa_types : [],
    placement_fee: r.placement_fee,
    has_housing: r.has_housing,
    has_meals: r.has_meals,
    source_kind: r.source_kind,
    repost: r.repost === true,
    is_saved: r.is_saved === true,
    is_revealed: r.is_revealed === true,
    // Present in every projection for a stable shape; non-null ONLY on the detail endpoint
    // for a scraped offer that is contactless OR city-less and whose source channel has a
    // username (feed/saved/user ads leave the column unselected -> undefined -> null). Public
    // link, no reveal gate.
    source_post_url: r.source_post_url ?? null,
  };
}

function encodeCursor(postedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ p: postedAt, i: id }), 'utf8').toString('base64url');
}
function decodeCursor(c: string | undefined): { p: string; i: string } | null {
  if (!c) return null;
  try {
    const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { p?: unknown; i?: unknown };
    // Validate `p` as a real timestamp: a non-timestamptz string would blow up the `::timestamptz`
    // cast in SQL and surface as a 500. A bad/forged cursor must degrade to the first page, not error.
    if (typeof o.p === 'string' && typeof o.i === 'string' && UUID_RE.test(o.i) && !Number.isNaN(Date.parse(o.p)))
      return { p: o.p, i: o.i };
  } catch {
    /* bad cursor -> first page */
  }
  return null;
}

/** The parsed VacancyQuery filters (everything EXCEPT paging/cursor). Shared, so the feed
 *  and the /count preview apply identical filter semantics. */
interface FeedFilters {
  slugs: string[];
  workTypes: string[];
  regions: string[];
  visa: string[];
  paid: 'free' | 'paid' | null;
  housing: boolean;
  meals: boolean;
  q: string;
  freshnessDays: number | null;
  // MULTI-CITY (contract): whether to ALSO show city-less offers when a city IS selected. Default
  // true (query param absent). Ignored when no city is selected (kj_city_match returns all anyway).
  noCity: boolean;
}

/** Parse the shared VacancyQuery filters from the request (identical for feed + count). */
function parseFeedFilters(req: ReqLike): FeedFilters {
  const csv = (name: string): string[] =>
    (queryParam(req, name) ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const paidRaw = queryParam(req, 'paid');
  const qRaw = queryParam(req, 'q') ?? queryParam(req, 'keywords') ?? '';
  const freshRaw = Number(queryParam(req, 'freshness'));
  // no_city: "1" (default/absent) shows city-less offers alongside the selected cities; "0" hides
  // them. Only meaningful when a city IS selected — kj_city_match ignores it otherwise (contract).
  const noCityRaw = queryParam(req, 'no_city');
  return {
    slugs: csv('cities'),
    workTypes: csv('work_types').filter((w) => WORK_TYPE_SET.has(w)),
    regions: csv('regions'),
    visa: csv('visa').filter((v) => VISA_TYPE_SET.has(v)),
    paid: paidRaw === 'free' || paidRaw === 'paid' ? paidRaw : null,
    housing: ['1', 'true'].includes(queryParam(req, 'housing') ?? ''),
    meals: ['1', 'true'].includes(queryParam(req, 'meals') ?? ''),
    q: qRaw.replace(/\./g, ' ').trim(),
    freshnessDays: FRESHNESS_DAYS.has(freshRaw) ? freshRaw : null,
    noCity: !(noCityRaw === '0' || noCityRaw === 'false'),
  };
}

// MULTI-CITY city semantics are SHARED across the app via kj_city_match(selected, detected, no_city)
// (draft_0020) so the feed, the /count preview and the daily digest apply the SAME rule and never
// drift. NOTE: notify/run.ts is DELIBERATELY narrower — it only pushes localized (city-scoped) offers
// and ignores no_city — see its header. Here (feed/detail/saved) is the full, no_city-aware surface.
//
// citiesAggSql — build a row's `cities` json array (contract): [{slug,name}, ...] resolved from the
// uuid[] `idsCol`, ORDERED main city first (the row's `idCol` == city_id) then the rest by slug. Names
// are the cities.name jsonb (identical shape to the single `city.name`). Empty offers -> [].
function citiesAggSql(idCol: string, idsCol: string): string {
  return `(select coalesce(json_agg(json_build_object('slug', cc.slug, 'name', cc.name)
      order by (cc.id = ${idCol}) desc, cc.slug), '[]'::json)
    from cities cc where cc.id = any(${idsCol}))`;
}

// The feed's row set: scraped vacancies ∪ APPROVED, unexpired user ads (a user ad's
// posted_at is greatest(created_at, bumped_at)). `search_tsv` is carried for the keyword filter. This is
// the SINGLE source of the union — the feed and the counter both wrap it, so they can
// never diverge on which rows exist. city_id + city_ids are projected so the outer query can build
// the `cities` array and apply the kj_city_match city filter.
//
// `is_saved`: when a caller id placeholder is given, LEFT JOIN the caller's bookmarks so
// each row carries whether it is saved. scraped rows join saved_vacancies; user ads join
// saved_ads (the two saved tables mirror the two feed sources). With `null` (the /count
// query, which returns no rows) the join is skipped and is_saved is a `false` literal.
// The join is on (id + fixed user_id) against a PK, so it never fans a row out.
function feedUnionSql(savedUserPh: string | null): string {
  const svJoin = savedUserPh
    ? `left join saved_vacancies sv on sv.vacancy_id = v.id and sv.user_id = ${savedUserPh}::uuid`
    : '';
  const svSel = savedUserPh ? '(sv.user_id is not null)' : 'false';
  const saJoin = savedUserPh
    ? `left join saved_ads sa on sa.ad_id = a.id and sa.user_id = ${savedUserPh}::uuid`
    : '';
  const saSel = savedUserPh ? '(sa.user_id is not null)' : 'false';
  // is_revealed mirrors is_saved: LEFT JOIN the caller's OWN reveal audit (contact_reveals for
  // scraped, ad_contact_reveals for user ads). Each join is on (id + fixed caller id) against a PK,
  // so it never fans a row out. With null caller (the /count query) it collapses to a `false` literal.
  const crJoin = savedUserPh
    ? `left join contact_reveals cr on cr.vacancy_id = v.id and cr.user_id = ${savedUserPh}::uuid`
    : '';
  const crSel = savedUserPh ? '(cr.user_id is not null)' : 'false';
  const arJoin = savedUserPh
    ? `left join ad_contact_reveals ar on ar.user_ad_id = a.id and ar.user_id = ${savedUserPh}::uuid`
    : '';
  const arSel = savedUserPh ? '(ar.user_id is not null)' : 'false';
  return `
  select v.id, c.slug as city_slug, c.name as city_name, v.city_id as city_id, v.city_ids as city_ids, v.region_slug,
         v.work_type::text as work_type, v.gender::text as gender,
         v.salary_text, v.salary_min, v.salary_max, v.salary_period::text as salary_period,
         v.employer, v.description, v.posted_at,
         (v.contact_normalized is not null) as has_contact,
         v.visa_types, v.placement_fee::text as placement_fee, v.has_housing, v.has_meals,
         'scraped'::text as source_kind, (v.repost_count > 0) as repost, ${svSel} as is_saved,
         ${crSel} as is_revealed, v.search_tsv
  from vacancies v
  left join cities c on c.id = v.city_id
  ${svJoin}
  ${crJoin}
  where v.is_active and v.duplicate_of is null
  union all
  select a.id, c.slug as city_slug, c.name as city_name, a.city_id as city_id, a.city_ids as city_ids, a.region_slug,
         a.work_type::text as work_type, 'any'::text as gender,
         a.salary_text, null::int as salary_min, null::int as salary_max, null::text as salary_period,
         null::text as employer, a.description,
         greatest(a.created_at, coalesce(a.bumped_at, a.created_at)) as posted_at,
         (a.contact_raw is not null) as has_contact,
         a.visa_types, a.placement_fee::text as placement_fee, a.has_housing, a.has_meals,
         'user'::text as source_kind, false as repost, ${saSel} as is_saved,
         ${arSel} as is_revealed, a.search_tsv
  from user_ads a
  left join cities c on c.id = a.city_id
  ${saJoin}
  ${arJoin}
  where a.status = 'approved' and (a.expires_at is null or a.expires_at > now())`;
}

// The SAVED feed's row set: the SAME projection as the main feed, but driven FROM the
// caller's bookmark tables (so we page over idx_saved_*_user) and INNER-joined to the
// content with the SAME visibility predicates as the feed. A bookmark whose vacancy/ad is
// no longer visible (inactive / taken down / expired / rejected) simply drops out — the
// row stays in saved_* but never surfaces stale/taken-down content (007). is_saved is a
// `true` literal here by construction; `saved_at` (the bookmark's created_at) is the cursor.
function savedUnionSql(userPh: string): string {
  // is_revealed here uses the SAME caller-scoped reveal audit as the main feed (contact_reveals /
  // ad_contact_reveals), LEFT-joined on the bookmarked item's id + the fixed caller id (PK -> no fan-out).
  return `
  select v.id, c.slug as city_slug, c.name as city_name, v.city_id as city_id, v.city_ids as city_ids, v.region_slug,
         v.work_type::text as work_type, v.gender::text as gender,
         v.salary_text, v.salary_min, v.salary_max, v.salary_period::text as salary_period,
         v.employer, v.description, v.posted_at,
         (v.contact_normalized is not null) as has_contact,
         v.visa_types, v.placement_fee::text as placement_fee, v.has_housing, v.has_meals,
         'scraped'::text as source_kind, (v.repost_count > 0) as repost, true as is_saved,
         (cr.user_id is not null) as is_revealed,
         s.created_at as saved_at
  from saved_vacancies s
  join vacancies v on v.id = s.vacancy_id and v.is_active and v.duplicate_of is null
  left join cities c on c.id = v.city_id
  left join contact_reveals cr on cr.vacancy_id = v.id and cr.user_id = ${userPh}::uuid
  where s.user_id = ${userPh}::uuid
  union all
  select a.id, c.slug as city_slug, c.name as city_name, a.city_id as city_id, a.city_ids as city_ids, a.region_slug,
         a.work_type::text as work_type, 'any'::text as gender,
         a.salary_text, null::int as salary_min, null::int as salary_max, null::text as salary_period,
         null::text as employer, a.description,
         greatest(a.created_at, coalesce(a.bumped_at, a.created_at)) as posted_at,
         (a.contact_raw is not null) as has_contact,
         a.visa_types, a.placement_fee::text as placement_fee, a.has_housing, a.has_meals,
         'user'::text as source_kind, false as repost, true as is_saved,
         (ar.user_id is not null) as is_revealed,
         s.created_at as saved_at
  from saved_ads s
  join user_ads a on a.id = s.ad_id and a.status = 'approved' and (a.expires_at is null or a.expires_at > now())
  left join cities c on c.id = a.city_id
  left join ad_contact_reveals ar on ar.user_ad_id = a.id and ar.user_id = ${userPh}::uuid
  where s.user_id = ${userPh}::uuid`;
}

/**
 * Build the shared, parameterized filter WHERE for the union `f` (paging/cursor EXCLUDED —
 * that is feed-only, and must not affect a total count). Returns the `where ...` text plus
 * the positional params, so the feed and /count run byte-identical filter semantics.
 *
 * Matching is PERMISSIVE for rare attributes (Sanya/Roma K2): a filter excludes only rows
 * that EXPLICITLY contradict it; "not stated"/empty always passes.
 * EXCEPTION (owner rule 2026-07-15): the housing / meals toggles are STRICT — when on they
 * show ONLY rows that EXPLICITLY state housing/meals (has_* is true); "not stated" (null) is
 * excluded. This applies to both the feed and the /count so they stay 1:1.
 */
function buildFilterWhere(f: FeedFilters): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const ph = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const wtEmpty = f.workTypes.length === 0;
  const regionsEmpty = f.regions.length === 0;
  const visaEmpty = f.visa.length === 0;
  const paidNull = f.paid === null;
  const hasQ = f.q.length > 0;
  const noFreshness = f.freshnessDays === null;

  // MULTI-CITY filter via the SHARED kj_city_match(selected, detected, no_city) predicate (draft_0020):
  //   * selected = the picked slugs resolved to uuids (a single, non-correlated subquery -> InitPlan,
  //     evaluated ONCE); empty selection -> the function returns true (show everything).
  //   * detected = the row's f.city_ids (the offer's full city set).
  //   * no_city  = only ever consulted when a city IS selected AND the offer is city-less.
  const where = `where kj_city_match(
        (select coalesce(array_agg(id), '{}'::uuid[]) from cities where slug = any(${ph(f.slugs)}::text[])),
        f.city_ids, ${ph(f.noCity)})
      and (${ph(wtEmpty)} or f.work_type = any(${ph(f.workTypes)}::text[]))
      and (${ph(regionsEmpty)} or f.region_slug = any(${ph(f.regions)}::text[]))
      and (${ph(visaEmpty)} or cardinality(f.visa_types) = 0 or 'any' = any(f.visa_types) or f.visa_types && ${ph(f.visa)}::visa_type[])
      and (${ph(paidNull)} or f.placement_fee = ${ph(f.paid)} or f.placement_fee = 'unknown')
      and (not ${ph(f.housing)} or f.has_housing is true)
      and (not ${ph(f.meals)} or f.has_meals is true)
      and (not ${ph(hasQ)} or f.search_tsv @@ websearch_to_tsquery('simple', ${ph(f.q)}))
      and (${ph(noFreshness)} or f.posted_at > now() - make_interval(days => ${ph(f.freshnessDays ?? 0)}))`;
  return { where, params };
}

/** GET /api/vacancies — cursor feed over (scraped vacancies ∪ approved user ads). */
export async function vacanciesFeed(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const filters = parseFeedFilters(req);
  const cur = decodeCursor(queryParam(req, 'cursor'));

  try {
    const sql = getSql();
    const { where, params } = buildFilterWhere(filters);
    // Continue numbering placeholders after the shared filter params (cursor + limit).
    const p = params.slice();
    const ph = (v: unknown): string => {
      p.push(v);
      return `$${p.length}`;
    };
    // Bind the caller id for the is_saved LEFT JOINs (scope is ALWAYS auth.user.id).
    const savedUserPh = ph(auth.user.id);
    const noCursor = cur === null;
    const cursorClause =
      `and (${ph(noCursor)} or (f.posted_at, f.id) < (${ph(cur?.p ?? null)}::timestamptz, ${ph(cur?.i ?? null)}::uuid))`;
    // visa_types is cast to text[] HERE (the JS projection), NOT inside feedUnionSql: the
    // enum-array column f.visa_types is consumed by buildFilterWhere's `&&`/`= any` against
    // visa_type[] (${where}), so it must stay visa_type[] in the union. Casting to text[]
    // only in the outer SELECT lets the neon driver parse it (enum arrays otherwise arrive as
    // a raw "{...}" string that toView's Array.isArray guard collapses to []).
    const text =
      `select f.id, f.city_slug, f.city_name, ${citiesAggSql('f.city_id', 'f.city_ids')} as cities,
             f.region_slug, f.work_type, f.gender,
             f.salary_text, f.salary_min, f.salary_max, f.salary_period, f.employer,
             f.description, f.posted_at, f.has_contact, f.visa_types::text[] as visa_types, f.placement_fee,
             f.has_housing, f.has_meals, f.source_kind, f.repost, f.is_saved, f.is_revealed
      from (${feedUnionSql(savedUserPh)}) f
      ${where}
      ${cursorClause}
      order by f.posted_at desc, f.id desc
      limit ${PAGE_SIZE + 1}`;
    const rows = (await sql(text, p)) as unknown as Row[];

    const hasMore = rows.length > PAGE_SIZE;
    const kept = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const items = kept.map(toView);
    const last = kept[kept.length - 1];
    const next_cursor =
      hasMore && last ? encodeCursor(new Date(last.posted_at).toISOString(), last.id) : null;

    send(res, 200, { items, next_cursor });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/**
 * count(*) over the SAME union and the SAME filter WHERE as vacanciesFeed (no paging), so
 * the number equals what the feed shows for the same VacancyQuery, 1:1.
 */
export async function countVacancies(sql: ReturnType<typeof getSql>, filters: FeedFilters): Promise<number> {
  const { where, params } = buildFilterWhere(filters);
  // No caller scope needed: /count returns no rows, so skip the is_saved join (null).
  const text = `select count(*)::int as c from (${feedUnionSql(null)}) f ${where}`;
  const rows = (await sql(text, params)) as unknown as { c: number }[];
  return rows[0]?.c ?? 0;
}

/** GET /api/vacancies/count — how many feed rows match the given VacancyQuery filters.
 *  Same auth (tma, 401 without initData) + same union + same soft filters as the feed;
 *  returns ONLY { count }, no rows. */
export async function vacanciesCount(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const filters = parseFeedFilters(req);
  try {
    const sql = getSql();
    const count = await countVacancies(sql, filters);
    send(res, 200, { count });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/** GET /api/vacancies/:id — one card (scraped OR approved user ad), no contact. */
export async function vacancyDetail(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const id = queryParam(req, 'id');
  if (!id || !UUID_RE.test(id)) return sendError(res, ApiErrorCode.NotFound);

  try {
    const sql = getSql();
    const vac = (await sql`
      select v.id, c.slug as city_slug, c.name as city_name,
             (select coalesce(json_agg(json_build_object('slug', cc.slug, 'name', cc.name)
                order by (cc.id = v.city_id) desc, cc.slug), '[]'::json)
              from cities cc where cc.id = any(v.city_ids)) as cities,
             v.region_slug,
             v.work_type::text as work_type, v.gender::text as gender,
             v.salary_text, v.salary_min, v.salary_max, v.salary_period::text as salary_period,
             v.employer, v.description, v.posted_at,
             (v.contact_normalized is not null) as has_contact,
             v.visa_types::text[] as visa_types, v.placement_fee::text as placement_fee, v.has_housing, v.has_meals,
             'scraped'::text as source_kind, (v.repost_count > 0) as repost,
             (exists (select 1 from saved_vacancies s
                      where s.user_id = ${auth.user.id}::uuid and s.vacancy_id = v.id)) as is_saved,
             (exists (select 1 from contact_reveals r
                      where r.user_id = ${auth.user.id}::uuid and r.vacancy_id = v.id)) as is_revealed,
             -- Fallback deep link to the original post — the contact ladder (offer carries no
             -- REVEALABLE contact) OR the "city not stated" case (cardinality(city_ids)=0: the user
             -- can't tell where the job is, so let them open the source post for context). Either
             -- way it is emitted ONLY when the source channel has a public username. Exposes the
             -- username in the URL and nothing else (no tg_chat_id / sender_id / internal ids).
             -- The contactless gate is "contact_normalized is null" — the SAME predicate as
             -- has_contact above — so the two never disagree: a row with a raw-but-unnormalized
             -- contact (has_contact=false) is treated as contactless and still gets the link,
             -- instead of losing BOTH the contact button and the channel link (dead end).
             -- tg_message_id is NOT NULL by schema; the guard covers the LEFT JOIN miss
             -- (raw_message_id nulled). city_ids is uuid[] NOT NULL, so cardinality is null-safe.
             case
               when (v.contact_normalized is null or cardinality(v.city_ids) = 0)
                and src.username is not null and src.username <> ''
                and rm.tg_message_id is not null
               then 'https://t.me/' || src.username || '/' || rm.tg_message_id::text
               else null
             end as source_post_url
      from vacancies v
      left join cities c on c.id = v.city_id
      left join raw_messages rm on rm.id = v.raw_message_id
      left join sources src on src.id = v.source_id
      where v.id = ${id}::uuid and v.is_active and v.duplicate_of is null
      limit 1`) as unknown as Row[];
    if (vac[0]) {
      // Daily OPEN streak: a delivered card (vacancy) counts today. Best-effort, once per Seoul day.
      await bumpOpenStreakBestEffort(sql, auth.user.id);
      return send(res, 200, toView(vac[0]));
    }

    const ad = (await sql`
      select a.id, c.slug as city_slug, c.name as city_name,
             (select coalesce(json_agg(json_build_object('slug', cc.slug, 'name', cc.name)
                order by (cc.id = a.city_id) desc, cc.slug), '[]'::json)
              from cities cc where cc.id = any(a.city_ids)) as cities,
             a.region_slug,
             a.work_type::text as work_type, 'any'::text as gender,
             a.salary_text, null::int as salary_min, null::int as salary_max, null::text as salary_period,
             null::text as employer, a.description,
             greatest(a.created_at, coalesce(a.bumped_at, a.created_at)) as posted_at,
             (a.contact_raw is not null) as has_contact,
             a.visa_types::text[] as visa_types, a.placement_fee::text as placement_fee, a.has_housing, a.has_meals,
             'user'::text as source_kind, false as repost,
             (exists (select 1 from saved_ads s
                      where s.user_id = ${auth.user.id}::uuid and s.ad_id = a.id)) as is_saved,
             (exists (select 1 from ad_contact_reveals r
                      where r.user_id = ${auth.user.id}::uuid and r.user_ad_id = a.id)) as is_revealed
      from user_ads a
      left join cities c on c.id = a.city_id
      where a.id = ${id}::uuid and a.status = 'approved' and (a.expires_at is null or a.expires_at > now())
      limit 1`) as unknown as Row[];
    if (ad[0]) {
      // Daily OPEN streak: a delivered card (user ad) counts today. Best-effort, once per Seoul day.
      await bumpOpenStreakBestEffort(sql, auth.user.id);
      return send(res, 200, toView(ad[0]));
    }

    return sendError(res, ApiErrorCode.NotFound);
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/** Total contact reveals by a user in the last 24h — ONE shared budget across scraped
 *  vacancies (contact_reveals) + user ads (ad_contact_reveals) + UNVERIFIED raw reveals
 *  (raw_contact_reveals, see raw/reveal.ts). Exported so the raw reveal counts the SAME cap. */
export async function reveals24h(sql: ReturnType<typeof getSql>, userId: string): Promise<number> {
  const r = (await sql`
    select (
      (select count(*) from contact_reveals     where user_id = ${userId}::uuid and revealed_at > now() - interval '24 hours') +
      (select count(*) from ad_contact_reveals  where user_id = ${userId}::uuid and revealed_at > now() - interval '24 hours') +
      (select count(*) from raw_contact_reveals where user_id = ${userId}::uuid and revealed_at > now() - interval '24 hours')
    )::int as c`) as unknown as { c: number }[];
  return (r[0]?.c as number | undefined) ?? 0;
}

/** GET /api/vacancies/:id/contact — reveal the contact on explicit action (scraped OR
 *  user ad). Per-user daily cap shared across both + audit, to prevent bulk harvesting. */
export async function vacancyContact(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const id = queryParam(req, 'id');
  // A missing/invalid :id is a not-found (a 200 {contact:null} would mask a bad id).
  if (!id || !UUID_RE.test(id)) return sendError(res, ApiErrorCode.NotFound);

  try {
    const sql = getSql();
    const cap = await getConfigNumber('contact_reveal_daily_cap', 50);

    // Scraped vacancy first.
    const vac = (await sql`
      select contact_raw, contact_kind from vacancies
      where id = ${id}::uuid and is_active and duplicate_of is null limit 1`) as unknown as {
      contact_raw: string | null;
      contact_kind: string | null;
    }[];
    if (vac[0]) {
      const already = await sql`
        select 1 from contact_reveals where user_id = ${auth.user.id}::uuid and vacancy_id = ${id}::uuid limit 1`;
      if (already.length === 0) {
        if ((await reveals24h(sql, auth.user.id)) >= cap) return sendError(res, ApiErrorCode.RateLimited);
        await sql`
          insert into contact_reveals (user_id, vacancy_id) values (${auth.user.id}::uuid, ${id}::uuid)
          on conflict (user_id, vacancy_id) do nothing`;
        // Referral accrual: first contact reveal is the target action that credits the
        // user's ancestors. Best-effort — a failure must never break the reveal response.
        try {
          const kind = await getConfigString('referral_activation_kind', 'contact_reveal');
          await recordReferralActivation(sql, auth.user.id, kind);
        } catch (err) {
          // Best-effort: the reveal must still succeed. But do NOT fail silently — a
          // systemic accrual break would otherwise kill ALL referrals invisibly. Log the
          // fact (message only, no PII) so monitoring can catch it.
          // eslint-disable-next-line no-console
          console.error('[referral] accrual failed (best-effort):', err instanceof Error ? err.message : String(err));
        }
      }
      const r = vac[0];
      if (!r.contact_raw) return send(res, 200, { contact: null });
      return send(res, 200, { contact: { kind: r.contact_kind ?? 'other', value: r.contact_raw } });
    }

    // Approved user ad.
    const ad = (await sql`
      select contact_raw, contact_kind from user_ads
      where id = ${id}::uuid and status = 'approved' and (expires_at is null or expires_at > now()) limit 1`) as unknown as {
      contact_raw: string | null;
      contact_kind: string | null;
    }[];
    if (ad[0]) {
      const already = await sql`
        select 1 from ad_contact_reveals where user_id = ${auth.user.id}::uuid and user_ad_id = ${id}::uuid limit 1`;
      if (already.length === 0) {
        if ((await reveals24h(sql, auth.user.id)) >= cap) return sendError(res, ApiErrorCode.RateLimited);
        await sql`
          insert into ad_contact_reveals (user_id, user_ad_id) values (${auth.user.id}::uuid, ${id}::uuid)
          on conflict (user_id, user_ad_id) do nothing`;
        // Referral accrual (same target action as scraped vacancies). Best-effort.
        try {
          const kind = await getConfigString('referral_activation_kind', 'contact_reveal');
          await recordReferralActivation(sql, auth.user.id, kind);
        } catch (err) {
          // Best-effort: the reveal must still succeed. But do NOT fail silently — a
          // systemic accrual break would otherwise kill ALL referrals invisibly. Log the
          // fact (message only, no PII) so monitoring can catch it.
          // eslint-disable-next-line no-console
          console.error('[referral] accrual failed (best-effort):', err instanceof Error ? err.message : String(err));
        }
      }
      const r = ad[0];
      if (!r.contact_raw) return send(res, 200, { contact: null });
      return send(res, 200, { contact: { kind: r.contact_kind ?? 'other', value: r.contact_raw } });
    }

    return sendError(res, ApiErrorCode.NotFound);
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/**
 * GET /api/saved — the caller's own bookmarks as a feed page, newest bookmark first.
 * Same auth + same `toView` projection as the feed (contacts stay hidden behind
 * has_contact; reveal is a separate endpoint). Scope is ALWAYS auth.user.id. Cursor pages
 * over (saved_at, id) — the bookmark's created_at — exactly like the feed's (posted_at, id).
 */
export async function savedFeed(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const cur = decodeCursor(queryParam(req, 'cursor'));
  try {
    const sql = getSql();
    const p: unknown[] = [];
    const ph = (v: unknown): string => {
      p.push(v);
      return `$${p.length}`;
    };
    const userPh = ph(auth.user.id);
    const noCursor = cur === null;
    const cursorClause =
      `and (${ph(noCursor)} or (f.saved_at, f.id) < (${ph(cur?.p ?? null)}::timestamptz, ${ph(cur?.i ?? null)}::uuid))`;
    // visa_types -> text[] in the JS projection so the neon driver parses the enum array
    // (see vacanciesFeed). savedUnionSql itself is left as visa_type[]; the saved feed applies
    // no visa filter, but keeping the cast at the projection boundary mirrors the main feed.
    const text =
      `select f.id, f.city_slug, f.city_name, ${citiesAggSql('f.city_id', 'f.city_ids')} as cities,
             f.region_slug, f.work_type, f.gender,
             f.salary_text, f.salary_min, f.salary_max, f.salary_period, f.employer,
             f.description, f.posted_at, f.has_contact, f.visa_types::text[] as visa_types, f.placement_fee,
             f.has_housing, f.has_meals, f.source_kind, f.repost, f.is_saved, f.is_revealed, f.saved_at
      from (${savedUnionSql(userPh)}) f
      where true
      ${cursorClause}
      order by f.saved_at desc, f.id desc
      limit ${PAGE_SIZE + 1}`;
    const rows = (await sql(text, p)) as unknown as Row[];

    const hasMore = rows.length > PAGE_SIZE;
    const kept = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const items = kept.map(toView);
    const last = kept[kept.length - 1];
    const next_cursor =
      hasMore && last && last.saved_at ? encodeCursor(new Date(last.saved_at).toISOString(), last.id) : null;

    send(res, 200, { items, next_cursor });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/**
 * POST   /api/vacancies/:id/save — bookmark this card (scraped OR user ad). Idempotent
 *                                  (`on conflict do nothing`). Returns { is_saved: true }.
 * DELETE /api/vacancies/:id/save — remove the bookmark. Idempotent. Returns { is_saved: false }.
 *
 * kind (scraped vs user ad) is resolved from :id exactly like vacancyContact/vacancyDetail.
 * The user is ALWAYS auth.user.id — NEVER the body/query (007: the only cross-user barrier).
 * A save requires a VISIBLE row (active scraped vacancy / approved unexpired ad); unsave is
 * a pure idempotent delete and does not.
 */
export async function vacancySave(req: ReqLike, res: ResLike): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'POST' && method !== 'DELETE') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const id = queryParam(req, 'id');
  if (!id || !UUID_RE.test(id)) return sendError(res, ApiErrorCode.NotFound);

  try {
    const sql = getSql();

    if (method === 'DELETE') {
      // Idempotent unsave. The two saved tables have disjoint id spaces (vacancy vs ad
      // uuids), so at most one delete matches; unsaving what was never saved is a no-op.
      await sql`delete from saved_vacancies where user_id = ${auth.user.id}::uuid and vacancy_id = ${id}::uuid`;
      await sql`delete from saved_ads where user_id = ${auth.user.id}::uuid and ad_id = ${id}::uuid`;
      return send(res, 200, { is_saved: false });
    }

    // POST → save. Resolve the id to its source table (only a VISIBLE row is saveable),
    // then insert into the matching bookmark table. on conflict → idempotent re-save.
    const vac = await sql`
      select 1 from vacancies
      where id = ${id}::uuid and is_active and duplicate_of is null limit 1`;
    if (vac.length > 0) {
      await sql`
        insert into saved_vacancies (user_id, vacancy_id) values (${auth.user.id}::uuid, ${id}::uuid)
        on conflict (user_id, vacancy_id) do nothing`;
      return send(res, 200, { is_saved: true });
    }

    const ad = await sql`
      select 1 from user_ads
      where id = ${id}::uuid and status = 'approved' and (expires_at is null or expires_at > now()) limit 1`;
    if (ad.length > 0) {
      await sql`
        insert into saved_ads (user_id, ad_id) values (${auth.user.id}::uuid, ${id}::uuid)
        on conflict (user_id, ad_id) do nothing`;
      return send(res, 200, { is_saved: true });
    }

    return sendError(res, ApiErrorCode.NotFound);
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
