// lib/korea/ads/manage.ts
//
// "Мои объявления" — an author manages an ad they placed through the mini app:
//   POST   /api/ads/:id/bump       -> refresh freshness (cooldown-gated)
//   POST   /api/ads/:id/archive    -> hide it (status='archived')
//   POST   /api/ads/:id/unarchive  -> bring it back through moderation
//   PATCH  /api/ads/:id            -> edit it (re-moderated) — adItem
//   DELETE /api/ads/:id            -> delete it forever          — adItem
//
// SECURITY (007): the ONLY cross-user barrier is author_user_id = auth.user.id, taken from
// the verified initData (context.ts) — NEVER from the body/query. A row that is not the
// caller's own resolves to 404 NotFound (not 403) so we never confirm a stranger's id
// exists. Every mutation carries `author_user_id = auth.user.id` in its WHERE too, so even
// a TOCTOU race can only ever touch the caller's own row.
//
// Re-moderation (unarchive + edit) reuses decideAdModeration BYTE-FOR-BYTE with create, so
// an edited/unarchived ad can never take a different route than a freshly created one with
// the same text — otherwise a post-approval edit would bypass the guard the create path runs.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, readJsonBody, queryParam } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate, type AuthedUser } from '../core/context.js';
import { getConfigNumber } from '../config.js';
import { decideAdModeration } from './moderation.js';
import { notifyAdminsPending, resolveAdCityIds, resolveAdRegionSlugs } from './rw.js';
import { notifyAuthorAdDecision } from '../notify/author.js';
import { parseAdInput, adModText, UUID_RE, type AdBody } from './input.js';

/** The caller's own ad, resolved once per request. Carries the columns every action needs
 *  (status/lifecycle for the guards + the stored text for unarchive re-moderation + the
 *  summary bits for an admin ping). */
interface OwnAdRow {
  id: string;
  status: string;
  created_at: string;
  bumped_at: string | null;
  updated_at: string;
  title: string | null;
  description: string | null;
  salary_text: string | null;
  schedule: string | null;
  housing_terms: string | null;
  meals_info: string | null;
  work_type: string;
  region_slug: string | null;
  city_slug: string | null;
  city_text: string | null;
}

/** Resolve the caller's OWN ad by id (both ::uuid). Returns null when it is missing OR not
 *  theirs — the handler then answers 404, so a stranger's id is never confirmed. */
async function findOwnAd(
  sql: ReturnType<typeof getSql>,
  id: string,
  userId: string,
): Promise<OwnAdRow | null> {
  const rows = (await sql`
    select a.id, a.status, a.created_at, a.bumped_at, a.updated_at,
           a.title, a.description, a.salary_text, a.schedule, a.housing_terms, a.meals_info,
           a.work_type::text as work_type, a.region_slug, a.city_text, c.slug as city_slug
    from user_ads a
    left join cities c on c.id = a.city_id
    where a.id = ${id}::uuid and a.author_user_id = ${userId}::uuid
    limit 1`) as unknown as OwnAdRow[];
  return rows[0] ?? null;
}

/** Shared preamble: method-guard + auth + :id validation + own-ad resolution. Returns the
 *  row and the authed user, or null after already sending the right error response. */
async function resolveOwn(
  req: ReqLike,
  res: ResLike,
  method: 'POST' | 'PATCH' | 'DELETE',
): Promise<{ sql: ReturnType<typeof getSql>; user: AuthedUser; ad: OwnAdRow } | null> {
  if ((req.method ?? 'GET').toUpperCase() !== method) {
    sendError(res, ApiErrorCode.NotFound);
    return null;
  }
  const auth = await authenticate(req);
  if (!auth.ok) {
    sendError(res, ApiErrorCode.Unauthorized);
    return null;
  }
  const id = queryParam(req, 'id');
  if (!id || !UUID_RE.test(id)) {
    sendError(res, ApiErrorCode.NotFound);
    return null;
  }
  const sql = getSql();
  const ad = await findOwnAd(sql, id, auth.user.id);
  if (!ad) {
    sendError(res, ApiErrorCode.NotFound);
    return null;
  }
  return { sql, user: auth.user, ad };
}

/** A human one-liner for the admin pending ping (same shape as adsCreate). */
function pendingSummary(cityLabel: string | null, workType: string, title: string | null): string {
  return [cityLabel ?? '—', workType, title].filter(Boolean).join(' · ');
}

/** POST /api/ads/:id/bump — refresh freshness so the ad floats back up the feed. Only the
 *  author, only an approved (non-archived) ad, and only past the cooldown; earlier → 429. */
export async function adBump(req: ReqLike, res: ResLike): Promise<void> {
  const ctx = await resolveOwn(req, res, 'POST');
  if (!ctx) return;
  const { sql, user, ad } = ctx;

  // 'archived' is its own status, so `= 'approved'` already excludes an archived ad.
  if (ad.status !== 'approved') return sendError(res, ApiErrorCode.BadRequest, 'ad is not approved');

  try {
    const ttl = await getConfigNumber('user_ad_ttl_days', 14);
    const cooldownH = await getConfigNumber('user_ad_bump_min_hours', 12);
    // Cooldown is enforced atomically in the WHERE against the DB clock (greatest of
    // created_at / bumped_at). status='approved' was just checked, so 0 rows = too soon.
    const rows = (await sql`
      update user_ads
      set bumped_at = now(),
          expires_at = now() + make_interval(days => ${ttl})
      where id = ${ad.id}::uuid and author_user_id = ${user.id}::uuid and status = 'approved'
        and greatest(created_at, coalesce(bumped_at, created_at)) <= now() - make_interval(hours => ${cooldownH})
      returning bumped_at`) as unknown as { bumped_at: string }[];
    if (rows.length === 0) return sendError(res, ApiErrorCode.RateLimited);
    send(res, 200, { ok: true, bumped_at: new Date(rows[0]!.bumped_at).toISOString() });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/** POST /api/ads/:id/archive — move the ad to the archive (drops out of the feed, which
 *  only shows status='approved'). Allowed from approved | pending | expired | rejected. */
export async function adArchive(req: ReqLike, res: ResLike): Promise<void> {
  const ctx = await resolveOwn(req, res, 'POST');
  if (!ctx) return;
  const { sql, user, ad } = ctx;

  if (!['approved', 'pending', 'expired', 'rejected'].includes(ad.status)) {
    return sendError(res, ApiErrorCode.BadRequest, 'ad cannot be archived from its current status');
  }
  try {
    const rows = (await sql`
      update user_ads set status = 'archived'
      where id = ${ad.id}::uuid and author_user_id = ${user.id}::uuid
        and status in ('approved', 'pending', 'expired', 'rejected')
      returning id`) as unknown as { id: string }[];
    if (rows.length === 0) return sendError(res, ApiErrorCode.NotFound);
    send(res, 200, { ok: true });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/** POST /api/ads/:id/unarchive — bring an archived ad back through moderation on its STORED
 *  text (same decision as create). status becomes approved | pending | rejected; an approve
 *  re-arms expires_at; notify_pending is left untouched (no re-broadcast to subscribers). */
export async function adUnarchive(req: ReqLike, res: ResLike): Promise<void> {
  const ctx = await resolveOwn(req, res, 'POST');
  if (!ctx) return;
  const { sql, user, ad } = ctx;

  if (ad.status !== 'archived') return sendError(res, ApiErrorCode.BadRequest, 'ad is not archived');

  try {
    // Anti-hammer (same gate as adPatch): an unarchive inside the config window since the
    // last update → 429, BEFORE the model runs. archive bumps updated_at (trigger), so an
    // archive→unarchive→archive loop upers straight into 429 here and never burns tokens.
    const editMins = await getConfigNumber('user_ad_edit_min_minutes', 10);
    const guard = (await sql`
      select (updated_at > now() - make_interval(mins => ${editMins})) as too_soon
      from user_ads where id = ${ad.id}::uuid and author_user_id = ${user.id}::uuid limit 1`) as unknown as {
      too_soon: boolean;
    }[];
    if (guard[0]?.too_soon) return sendError(res, ApiErrorCode.RateLimited);

    // Re-moderate the SAVED text (city/fields are unchanged, so we do NOT re-resolve city).
    const modText = adModText(ad.title, ad.description, ad.salary_text, ad.schedule, ad.housing_terms, ad.meals_info);
    const { status, rejectReason, aiConfidence } = await decideAdModeration(modText);
    const ttl = await getConfigNumber('user_ad_ttl_days', 14);

    const rows = (await sql`
      update user_ads set
        status = ${status}::user_ad_status,
        moderated_at = case when ${status} = 'pending' then null else now() end,
        reject_reason = ${rejectReason},
        ai_confidence = ${aiConfidence},
        expires_at = case when ${status} = 'approved' then now() + make_interval(days => ${ttl}) else null end
      where id = ${ad.id}::uuid and author_user_id = ${user.id}::uuid and status = 'archived'
      returning id`) as unknown as { id: string }[];
    if (rows.length === 0) return sendError(res, ApiErrorCode.NotFound);

    if (status === 'pending') {
      await notifyAdminsPending(sql, ad.id, pendingSummary(ad.city_slug ?? ad.city_text ?? ad.region_slug, ad.work_type, ad.title));
    }
    // Unarchive always re-moderates from 'archived', so any outcome is a REAL transition; tell the
    // author (best-effort): pending (apology), approved (published) or rejected (reason).
    await notifyAuthorAdDecision(sql, ad.id, status, rejectReason, ad.status);
    send(res, 200, { ok: true, status });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/** PATCH /api/ads/:id — edit. Full AdInput (the app always sends every field). Re-moderation
 *  is MANDATORY (a post-approval edit must not bypass the guard); status/reject_reason/
 *  ai_confidence are overwritten, an approve re-arms expires_at, and an archived ad becomes
 *  active again. notify_pending is left untouched. Anti-hammer: an edit inside the config
 *  window since the last update → 429. Any status except taken_down may be edited. */
async function adPatch(req: ReqLike, res: ResLike): Promise<void> {
  const ctx = await resolveOwn(req, res, 'PATCH');
  if (!ctx) return;
  const { sql, user, ad } = ctx;

  if (ad.status === 'taken_down') return sendError(res, ApiErrorCode.BadRequest, 'ad cannot be edited');

  // Parse+validate BEFORE spending model tokens; same rules as create.
  const parsed = parseAdInput((await readJsonBody(req)) as AdBody | null);
  if (!parsed.ok) return sendError(res, ApiErrorCode.BadRequest, parsed.error);
  const f = parsed.fields;

  try {
    // Anti-hammer: compare updated_at against the DB clock (not the app's) so the window is exact.
    const editMins = await getConfigNumber('user_ad_edit_min_minutes', 10);
    const guard = (await sql`
      select (updated_at > now() - make_interval(mins => ${editMins})) as too_soon
      from user_ads where id = ${ad.id}::uuid and author_user_id = ${user.id}::uuid limit 1`) as unknown as {
      too_soon: boolean;
    }[];
    if (guard[0]?.too_soon) return sendError(res, ApiErrorCode.RateLimited);

    // Re-moderate the NEW text — identical decision to adsCreate.
    const modText = adModText(f.title, f.description, f.salaryText, f.schedule, f.housingTerms, f.mealsInfo);
    const { status, rejectReason, item, cityIdBySlug, aiConfidence } = await decideAdModeration(modText);

    // Re-resolve city from the new fields, exactly like create (a patch may change the city).
    const citySlug = (f.reqCitySlug && cityIdBySlug.has(f.reqCitySlug) ? f.reqCitySlug : null) ?? item?.city_slug ?? null;
    const cityId = citySlug ? cityIdBySlug.get(citySlug) ?? null : null;
    const cityText = cityId ? null : f.reqCityText;
    const regionSlug = f.reqRegion ?? item?.region_slug ?? null;
    const ttl = await getConfigNumber('user_ad_ttl_days', 14);
    // MULTI-CITY: recompute city_ids on edit exactly like create — primary (city_id) is the form pick,
    // plus any city named in the new description. A patch may change the text, so re-derive from scratch.
    const cityIds = await resolveAdCityIds(sql, cityId, f.description);
    // MULTI-REGION (regions wave): recompute region_slugs on edit exactly like adsCreate — the regions of
    // the resolved cities ∪ the singular region_slug pick ∪ every region named in the new text. A patch
    // may change the city/text, so re-derive from scratch (symmetric with adsCreate). WITHOUT this an
    // edited ad kept its OLD region_slugs and silently fell out of the region filter after a region change.
    const regionSlugs = await resolveAdRegionSlugs(sql, cityIds, regionSlug, f.description);

    const rows = (await sql`
      update user_ads set
        city_id = ${cityId}::uuid,
        city_ids = ${cityIds}::uuid[],
        city_text = ${cityText},
        region_slug = ${regionSlug},
        region_slugs = ${regionSlugs}::text[],
        work_type = ${f.workType}::work_type,
        visa_types = ${f.visaTypes}::visa_type[],
        placement_fee = ${f.placementFee}::placement_fee,
        has_housing = ${f.hasHousing},
        has_meals = ${f.hasMeals},
        salary_text = ${f.salaryText},
        title = ${f.title},
        description = ${f.description},
        contact_raw = ${f.contactRaw},
        contact_kind = ${f.contactKind}::contact_kind,
        housing_terms = ${f.housingTerms},
        meals_info = ${f.mealsInfo},
        schedule = ${f.schedule},
        status = ${status}::user_ad_status,
        moderated_at = case when ${status} = 'pending' then null else now() end,
        reject_reason = ${rejectReason},
        ai_confidence = ${aiConfidence},
        expires_at = case when ${status} = 'approved' then now() + make_interval(days => ${ttl}) else null end
      where id = ${ad.id}::uuid and author_user_id = ${user.id}::uuid and status <> 'taken_down'
      returning id`) as unknown as { id: string }[];
    if (rows.length === 0) return sendError(res, ApiErrorCode.NotFound);

    if (status === 'pending') {
      await notifyAdminsPending(sql, ad.id, pendingSummary(citySlug ?? cityText ?? regionSlug, f.workType, f.title));
    }
    // Author DM only on a REAL status transition (prevStatus = ad.status): pending (apology),
    // approved (published) or rejected (reason). A re-edit that stays the SAME status stays silent
    // — no re-spamming "опубликовано"/"на проверке" on every save of an already-decided ad.
    await notifyAuthorAdDecision(sql, ad.id, status, rejectReason, ad.status);
    send(res, 200, { ok: true, status });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/** DELETE /api/ads/:id — hard delete, forever. Only the author (author_user_id = auth.user.id
 *  is the sole barrier). Cascades saved_ads / ad_contact_reveals (FK on delete cascade). */
async function adDelete(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET').toUpperCase() !== 'DELETE') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const id = queryParam(req, 'id');
  if (!id || !UUID_RE.test(id)) return sendError(res, ApiErrorCode.NotFound);

  try {
    const sql = getSql();
    const rows = (await sql`
      delete from user_ads
      where id = ${id}::uuid and author_user_id = ${auth.user.id}::uuid
      returning id`) as unknown as { id: string }[];
    if (rows.length === 0) return sendError(res, ApiErrorCode.NotFound);
    send(res, 200, { ok: true });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/** PATCH | DELETE /api/ads/:id — one route, dispatched by method (edit vs delete forever). */
export async function adItem(req: ReqLike, res: ResLike): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'PATCH') return adPatch(req, res);
  if (method === 'DELETE') return adDelete(req, res);
  return sendError(res, ApiErrorCode.NotFound);
}
