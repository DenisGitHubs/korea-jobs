// lib/korea/vacancies/read.ts
//
// The vacancy feed + detail + contact reveal. Matches the mini-app contract
// (app/src/shared/types/api.ts) exactly.
//
// SECURITY (007): explicit column projection — NEVER expose source_id /
// raw_message_id / content_hash / internal ids. The feed and detail carry
// `has_contact` but not the value; the phone/handle is returned ONLY by /contact.
//   * The parser is told to keep contacts out of title/description/employer, and
//     scrubContacts() here strips any that slip through (defense in depth).
//   * /contact enforces a per-user daily cap + records the reveal (contact_reveals),
//     so one account can't scrape every employer's phone.
// Dynamic filter fields are whitelisted; ids are validated before hitting the DB.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, queryParam } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { getConfigNumber } from '../config.js';
import { WORK_TYPES } from '../parser/prompt.js';

const PAGE_SIZE = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORK_TYPE_SET = new Set<string>(WORK_TYPES);

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

/** GET /api/vacancies — cursor feed, filtered by cities/work_types, newest first. */
export async function vacanciesFeed(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const slugs = (queryParam(req, 'cities') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const workTypes = (queryParam(req, 'work_types') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((w) => WORK_TYPE_SET.has(w));
  const cur = decodeCursor(queryParam(req, 'cursor'));

  const citiesEmpty = slugs.length === 0;
  const wtEmpty = workTypes.length === 0;
  const noCursor = cur === null;

  try {
    const sql = getSql();
    const rows = (await sql`
      select v.id, c.slug as city_slug, c.name as city_name, v.region_slug, v.work_type, v.gender,
             v.salary_text, v.salary_min, v.salary_max, v.salary_period, v.employer, v.description, v.posted_at,
             (v.contact_normalized is not null) as has_contact
      from vacancies v
      left join cities c on c.id = v.city_id
      where v.is_active and v.duplicate_of is null
        and (${citiesEmpty} or v.city_id in (select id from cities where slug = any(${slugs}::text[])))
        and (${wtEmpty} or v.work_type = any(${workTypes}::work_type[]))
        and (${noCursor} or (v.posted_at, v.id) < (${cur?.p ?? null}::timestamptz, ${cur?.i ?? null}::uuid))
      order by v.posted_at desc, v.id desc
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

/** GET /api/vacancies/:id — one card, no contact. */
export async function vacancyDetail(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const id = queryParam(req, 'id');
  if (!id || !UUID_RE.test(id)) return sendError(res, ApiErrorCode.NotFound);

  try {
    const sql = getSql();
    const rows = (await sql`
      select v.id, c.slug as city_slug, c.name as city_name, v.region_slug, v.work_type, v.gender,
             v.salary_text, v.salary_min, v.salary_max, v.salary_period, v.employer, v.description, v.posted_at,
             (v.contact_normalized is not null) as has_contact
      from vacancies v
      left join cities c on c.id = v.city_id
      where v.id = ${id}::uuid and v.is_active and v.duplicate_of is null
      limit 1`) as unknown as Row[];
    if (!rows[0]) return sendError(res, ApiErrorCode.NotFound);
    send(res, 200, toView(rows[0]));
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/** GET /api/vacancies/:id/contact — reveal the employer contact on explicit action.
 *  Per-user daily cap + audit (contact_reveals) to prevent bulk harvesting. */
export async function vacancyContact(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const id = queryParam(req, 'id');
  if (!id || !UUID_RE.test(id)) return send(res, 200, { contact: null });

  try {
    const sql = getSql();

    // A repeat reveal of the same vacancy is free (recorded once). A NEW reveal counts
    // against the per-user 24h cap.
    const already = await sql`
      select 1 from contact_reveals where user_id = ${auth.user.id}::uuid and vacancy_id = ${id}::uuid limit 1`;
    if (already.length === 0) {
      const cap = await getConfigNumber('contact_reveal_daily_cap', 50);
      const cnt = await sql`
        select count(*)::int as c from contact_reveals
        where user_id = ${auth.user.id}::uuid and revealed_at > now() - interval '24 hours'`;
      if (((cnt[0]?.c as number | undefined) ?? 0) >= cap) return sendError(res, ApiErrorCode.RateLimited);
      await sql`
        insert into contact_reveals (user_id, vacancy_id) values (${auth.user.id}::uuid, ${id}::uuid)
        on conflict (user_id, vacancy_id) do nothing`;
    }

    const rows = (await sql`
      select contact_raw, contact_kind from vacancies
      where id = ${id}::uuid and is_active and duplicate_of is null
      limit 1`) as unknown as { contact_raw: string | null; contact_kind: string | null }[];
    const r = rows[0];
    if (!r || !r.contact_raw) return send(res, 200, { contact: null });
    send(res, 200, { contact: { kind: r.contact_kind ?? 'other', value: r.contact_raw } });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
