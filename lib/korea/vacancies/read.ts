// lib/korea/vacancies/read.ts
//
// The vacancy feed + detail + contact reveal. Matches the mini-app contract
// (app/src/shared/types/api.ts) exactly.
//
// The feed is the UNION of scraped vacancies and APPROVED, unexpired user_ads, paged
// by a single cursor over (posted_at, id). Each row carries source_kind so the client
// can tell them apart; a user ad's posted_at is its created_at.
//
// SECURITY (007): explicit column projection — NEVER expose source_id /
// raw_message_id / content_hash / internal ids. The feed and detail carry
// `has_contact` but not the value; the phone/handle is returned ONLY by /contact.
//   * The parser is told to keep contacts out of title/description/employer, and
//     scrubContacts() here strips any that slip through (defense in depth).
//   * /contact enforces a per-user daily cap (shared across scraped + user ads) and
//     records the reveal, so one account can't scrape every employer's phone.
// Dynamic filter fields are whitelisted; ids are validated before hitting the DB.
//
// Filter matching is PERMISSIVE for rare attributes (Sanya/Roma K2): a filter excludes
// only rows that EXPLICITLY contradict it; "not stated"/empty always passes.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, queryParam } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { getConfigNumber } from '../config.js';
import { WORK_TYPES, VISA_TYPES } from '../parser/prompt.js';

const PAGE_SIZE = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORK_TYPE_SET = new Set<string>(WORK_TYPES);
const VISA_TYPE_SET = new Set<string>(VISA_TYPES);
const FRESHNESS_DAYS = new Set([1, 3, 7, 14]);

interface Row {
  id: string;
  city_slug: string | null;
  city_name: unknown;
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
}

/** Strip obvious contacts (phones, @handles, t.me/wa.me/kakao links) from free text. */
function scrubContacts(text: string | null): string | null {
  if (!text) return text;
  return text
    .replace(/(?:https?:\/\/)?(?:t\.me|wa\.me|open\.kakao\.com|kakao\.com)\/\S+/gi, '[скрыто]')
    .replace(/@[A-Za-z0-9_]{4,}/g, '[скрыто]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[скрыто]');
}

/** DB row -> VacancyView (feed/detail projection; never includes `contact`). */
function toView(r: Row) {
  return {
    id: r.id,
    city: r.city_slug ? { slug: r.city_slug, name: r.city_name } : null,
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
  };
}

function encodeCursor(postedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ p: postedAt, i: id }), 'utf8').toString('base64url');
}
function decodeCursor(c: string | undefined): { p: string; i: string } | null {
  if (!c) return null;
  try {
    const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { p?: unknown; i?: unknown };
    if (typeof o.p === 'string' && typeof o.i === 'string' && UUID_RE.test(o.i)) return { p: o.p, i: o.i };
  } catch {
    /* bad cursor -> first page */
  }
  return null;
}

/** GET /api/vacancies — cursor feed over (scraped vacancies ∪ approved user ads). */
export async function vacanciesFeed(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const csv = (name: string): string[] =>
    (queryParam(req, name) ?? '').split(',').map((x) => x.trim()).filter(Boolean);

  const slugs = csv('cities');
  const workTypes = csv('work_types').filter((w) => WORK_TYPE_SET.has(w));
  const regions = csv('regions');
  const visa = csv('visa').filter((v) => VISA_TYPE_SET.has(v));
  const paidRaw = queryParam(req, 'paid');
  const paidVal = paidRaw === 'free' || paidRaw === 'paid' ? paidRaw : null;
  const housing = queryParam(req, 'housing') === '1';
  const meals = queryParam(req, 'meals') === '1';
  const qRaw = queryParam(req, 'q') ?? queryParam(req, 'keywords') ?? '';
  const q = qRaw.replace(/\./g, ' ').trim();
  const freshRaw = Number(queryParam(req, 'freshness'));
  const freshnessDays = FRESHNESS_DAYS.has(freshRaw) ? freshRaw : null;
  const cur = decodeCursor(queryParam(req, 'cursor'));

  const citiesEmpty = slugs.length === 0;
  const wtEmpty = workTypes.length === 0;
  const regionsEmpty = regions.length === 0;
  const visaEmpty = visa.length === 0;
  const paidNull = paidVal === null;
  const hasQ = q.length > 0;
  const noFreshness = freshnessDays === null;
  const noCursor = cur === null;

  try {
    const sql = getSql();
    const rows = (await sql`
      select f.id, f.city_slug, f.city_name, f.region_slug, f.work_type, f.gender,
             f.salary_text, f.salary_min, f.salary_max, f.salary_period, f.employer,
             f.description, f.posted_at, f.has_contact, f.visa_types, f.placement_fee,
             f.has_housing, f.has_meals, f.source_kind, f.repost
      from (
        select v.id, c.slug as city_slug, c.name as city_name, v.region_slug,
               v.work_type::text as work_type, v.gender::text as gender,
               v.salary_text, v.salary_min, v.salary_max, v.salary_period::text as salary_period,
               v.employer, v.description, v.posted_at,
               (v.contact_normalized is not null) as has_contact,
               v.visa_types, v.placement_fee::text as placement_fee, v.has_housing, v.has_meals,
               'scraped'::text as source_kind, (v.repost_count > 0) as repost, v.search_tsv
        from vacancies v
        left join cities c on c.id = v.city_id
        where v.is_active and v.duplicate_of is null
        union all
        select a.id, c.slug as city_slug, c.name as city_name, a.region_slug,
               a.work_type::text as work_type, 'any'::text as gender,
               a.salary_text, null::int as salary_min, null::int as salary_max, null::text as salary_period,
               null::text as employer, a.description, a.created_at as posted_at,
               (a.contact_raw is not null) as has_contact,
               a.visa_types, a.placement_fee::text as placement_fee, a.has_housing, a.has_meals,
               'user'::text as source_kind, false as repost, a.search_tsv
        from user_ads a
        left join cities c on c.id = a.city_id
        where a.status = 'approved' and (a.expires_at is null or a.expires_at > now())
      ) f
      where (${citiesEmpty} or f.city_slug = any(${slugs}::text[]))
        and (${wtEmpty} or f.work_type = any(${workTypes}::text[]))
        and (${regionsEmpty} or f.region_slug = any(${regions}::text[]))
        and (${visaEmpty} or cardinality(f.visa_types) = 0 or 'any' = any(f.visa_types) or f.visa_types && ${visa}::visa_type[])
        and (${paidNull} or f.placement_fee = ${paidVal} or f.placement_fee = 'unknown')
        and (not ${housing} or f.has_housing is true or f.has_housing is null)
        and (not ${meals} or f.has_meals is true or f.has_meals is null)
        and (not ${hasQ} or f.search_tsv @@ websearch_to_tsquery('simple', ${q}))
        and (${noFreshness} or f.posted_at > now() - make_interval(days => ${freshnessDays ?? 0}))
        and (${noCursor} or (f.posted_at, f.id) < (${cur?.p ?? null}::timestamptz, ${cur?.i ?? null}::uuid))
      order by f.posted_at desc, f.id desc
      limit ${PAGE_SIZE + 1}`) as unknown as Row[];

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
      select v.id, c.slug as city_slug, c.name as city_name, v.region_slug,
             v.work_type::text as work_type, v.gender::text as gender,
             v.salary_text, v.salary_min, v.salary_max, v.salary_period::text as salary_period,
             v.employer, v.description, v.posted_at,
             (v.contact_normalized is not null) as has_contact,
             v.visa_types, v.placement_fee::text as placement_fee, v.has_housing, v.has_meals,
             'scraped'::text as source_kind, (v.repost_count > 0) as repost
      from vacancies v
      left join cities c on c.id = v.city_id
      where v.id = ${id}::uuid and v.is_active and v.duplicate_of is null
      limit 1`) as unknown as Row[];
    if (vac[0]) return send(res, 200, toView(vac[0]));

    const ad = (await sql`
      select a.id, c.slug as city_slug, c.name as city_name, a.region_slug,
             a.work_type::text as work_type, 'any'::text as gender,
             a.salary_text, null::int as salary_min, null::int as salary_max, null::text as salary_period,
             null::text as employer, a.description, a.created_at as posted_at,
             (a.contact_raw is not null) as has_contact,
             a.visa_types, a.placement_fee::text as placement_fee, a.has_housing, a.has_meals,
             'user'::text as source_kind, false as repost
      from user_ads a
      left join cities c on c.id = a.city_id
      where a.id = ${id}::uuid and a.status = 'approved' and (a.expires_at is null or a.expires_at > now())
      limit 1`) as unknown as Row[];
    if (ad[0]) return send(res, 200, toView(ad[0]));

    return sendError(res, ApiErrorCode.NotFound);
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/** Total contact reveals by a user in the last 24h, across scraped + user ads. */
async function reveals24h(sql: ReturnType<typeof getSql>, userId: string): Promise<number> {
  const r = (await sql`
    select (
      (select count(*) from contact_reveals    where user_id = ${userId}::uuid and revealed_at > now() - interval '24 hours') +
      (select count(*) from ad_contact_reveals where user_id = ${userId}::uuid and revealed_at > now() - interval '24 hours')
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
