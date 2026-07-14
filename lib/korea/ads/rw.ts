// lib/korea/ads/rw.ts
//
// User-submitted ads ("Разместить"):
//   POST /api/ads            (user)  -> validate + AI-moderate -> approved/pending/rejected
//   GET  /api/ads/mine       (user)  -> the caller's own ads
//   POST /api/ads/:id/moderate (admin)-> approve/reject (also usable via the bot buttons)
//
// A 'pending' ad is pushed to the admins' DMs with inline Approve/Reject buttons
// (handled in bot/webhook.ts); the API endpoint is the equivalent manual path. Both
// paths record the decision into moderation_examples for the classifier to learn from.
//
// SECURITY: author id comes ONLY from verified initData. Contacts stay in contact_raw
// (never logged). Body text is data.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, readJsonBody, queryParam } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { requireAdmin } from '../admin/auth.js';
import { getConfigNumber } from '../config.js';
import { sendMessage } from '../bot/telegram.js';
import { adminTelegramIds } from '../admin/auth.js';
import { classifyAdText, recordModerationExample } from './moderation.js';
import { WORK_TYPES, VISA_TYPES, PLACEMENT_FEES, CONTACT_KINDS } from '../parser/prompt.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORK_TYPE_SET = new Set<string>(WORK_TYPES);
const VISA_TYPE_SET = new Set<string>(VISA_TYPES);
const PLACEMENT_FEE_SET = new Set<string>(PLACEMENT_FEES);
const CONTACT_KIND_SET = new Set<string>(CONTACT_KINDS);

type AdStatus = 'approved' | 'pending' | 'rejected';

interface AdBody {
  city_slug?: unknown;
  region_slug?: unknown;
  work_type?: unknown;
  visa_types?: unknown;
  placement_fee?: unknown;
  has_housing?: unknown;
  has_meals?: unknown;
  salary_text?: unknown;
  title?: unknown;
  description?: unknown;
  contact_raw?: unknown;
  contact_kind?: unknown;
  housing_terms?: unknown;
  meals_info?: unknown;
  schedule?: unknown;
}

const s = (v: unknown, max = 2000): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const tri = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const visaArr = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && VISA_TYPE_SET.has(x)))] : [];

/** Notify configured admins about a pending ad with inline Approve/Reject buttons. */
async function notifyAdminsPending(adId: string, summary: string): Promise<void> {
  const ids = [...adminTelegramIds()];
  if (ids.length === 0) return;
  const extra = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Одобрить', callback_data: `ad:approve:${adId}` },
          { text: 'Отклонить', callback_data: `ad:reject:${adId}` },
        ],
      ],
    },
  };
  for (const id of ids) {
    try {
      await sendMessage(id, `Новое объявление на модерацию:\n${summary}`, extra);
    } catch {
      // eslint-disable-next-line no-console
      console.error('[ads] admin notify failed');
    }
  }
}

/** POST /api/ads — create a user ad, AI-moderated. */
export async function adsCreate(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const body = (await readJsonBody(req)) as AdBody | null;
  const title = s(body?.title, 120);
  const description = s(body?.description, 4000);
  const contactRaw = s(body?.contact_raw, 200);
  if (!title || !description || !contactRaw) {
    return sendError(res, ApiErrorCode.BadRequest, 'title, description and contact_raw are required');
  }

  const workType = typeof body?.work_type === 'string' && WORK_TYPE_SET.has(body.work_type) ? body.work_type : 'other';
  const visaTypes = visaArr(body?.visa_types);
  const placementFee =
    typeof body?.placement_fee === 'string' && PLACEMENT_FEE_SET.has(body.placement_fee)
      ? body.placement_fee
      : 'unknown';
  const contactKind =
    typeof body?.contact_kind === 'string' && CONTACT_KIND_SET.has(body.contact_kind) ? body.contact_kind : null;
  const hasHousing = tri(body?.has_housing);
  const hasMeals = tri(body?.has_meals);
  const salaryText = s(body?.salary_text, 500);
  const housingTerms = s(body?.housing_terms, 1000);
  const mealsInfo = s(body?.meals_info, 1000);
  const schedule = s(body?.schedule, 500);
  const reqRegion = s(body?.region_slug, 60);
  const reqCitySlug = s(body?.city_slug, 60);

  // AI moderation over the user's text (title + description + extras).
  const modText = [title, description, salaryText, schedule, housingTerms, mealsInfo].filter(Boolean).join('\n');
  const { item, cityIdBySlug } = await classifyAdText(modText);

  // Decision (thresholds in config; permissive default → human review, not silent drop).
  const autoApproveMin = await getConfigNumber('ads_auto_approve_min', 0.8);
  const conf = item?.confidence ?? 0;
  let status: AdStatus;
  let rejectReason: string | null = null;
  if (!item) {
    status = 'pending'; // model/transport failed → route to a human
  } else if (item.reject_reason === 'spam' || (!item.is_vacancy && conf >= 0.8)) {
    status = 'rejected';
    rejectReason = item.reject_reason ?? 'not_vacancy';
  } else if (item.is_vacancy && conf >= autoApproveMin && !item.reject_reason) {
    status = 'approved';
  } else {
    status = 'pending';
    rejectReason = item.reject_reason ?? null;
  }
  const aiConfidence = item?.confidence ?? null;

  // Resolve city: user's pick wins; else the AI-picked slug.
  const citySlug = (reqCitySlug && cityIdBySlug.has(reqCitySlug) ? reqCitySlug : null) ?? item?.city_slug ?? null;
  const cityId = citySlug ? cityIdBySlug.get(citySlug) ?? null : null;
  const regionSlug = reqRegion ?? item?.region_slug ?? null;

  const ttl = await getConfigNumber('user_ad_ttl_days', 14);

  try {
    const sql = getSql();
    const rows = (await sql`
      insert into user_ads (
        author_user_id, city_id, region_slug, work_type, visa_types, placement_fee,
        has_housing, has_meals, salary_text, title, description, contact_raw, contact_kind,
        housing_terms, meals_info, schedule, status, moderated_at, reject_reason, ai_confidence, expires_at
      ) values (
        ${auth.user.id}::uuid, ${cityId}::uuid, ${regionSlug}, ${workType}::work_type,
        ${visaTypes}::visa_type[], ${placementFee}::placement_fee,
        ${hasHousing}, ${hasMeals}, ${salaryText}, ${title}, ${description}, ${contactRaw}, ${contactKind}::contact_kind,
        ${housingTerms}, ${mealsInfo}, ${schedule},
        ${status}::user_ad_status,
        case when ${status} = 'pending' then null else now() end,
        ${rejectReason}, ${aiConfidence},
        case when ${status} = 'approved' then now() + make_interval(days => ${ttl}) else null end
      )
      returning id`) as unknown as { id: string }[];
    const id = rows[0]?.id;

    // Record the automatic decision for learning (only the clear-cut auto outcomes).
    if (id && status !== 'pending') {
      await recordModerationExample(modText, status === 'approved' ? 'approved' : 'rejected', rejectReason);
    }
    // Pending → push to admins for a manual call.
    if (id && status === 'pending') {
      const summary = [citySlug ?? regionSlug ?? '—', workType, title].filter(Boolean).join(' · ');
      await notifyAdminsPending(id, summary);
    }

    send(res, 200, { id: id ?? null, status });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

interface AdRow {
  id: string;
  city_slug: string | null;
  city_name: unknown;
  region_slug: string | null;
  work_type: string;
  visa_types: string[];
  placement_fee: string;
  has_housing: boolean | null;
  has_meals: boolean | null;
  salary_text: string | null;
  title: string | null;
  description: string | null;
  contact_raw: string | null;
  contact_kind: string | null;
  housing_terms: string | null;
  meals_info: string | null;
  schedule: string | null;
  status: string;
  reject_reason: string | null;
  created_at: string;
  expires_at: string | null;
}

/** GET /api/ads/mine — the caller's own ads (any status), newest first. */
export async function adsMine(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  try {
    const sql = getSql();
    const rows = (await sql`
      select a.id, c.slug as city_slug, c.name as city_name, a.region_slug, a.work_type,
             a.visa_types, a.placement_fee, a.has_housing, a.has_meals, a.salary_text,
             a.title, a.description, a.contact_raw, a.contact_kind,
             a.housing_terms, a.meals_info, a.schedule, a.status, a.reject_reason,
             a.created_at, a.expires_at
      from user_ads a
      left join cities c on c.id = a.city_id
      where a.author_user_id = ${auth.user.id}::uuid
      order by a.created_at desc
      limit 100`) as unknown as AdRow[];

    const items = rows.map((r) => ({
      id: r.id,
      city: r.city_slug ? { slug: r.city_slug, name: r.city_name } : null,
      region_slug: r.region_slug ?? null,
      work_type: r.work_type,
      visa_types: Array.isArray(r.visa_types) ? r.visa_types : [],
      placement_fee: r.placement_fee,
      has_housing: r.has_housing,
      has_meals: r.has_meals,
      salary_text: r.salary_text ?? null,
      title: r.title ?? '',
      description: r.description ?? '',
      contact_raw: r.contact_raw ?? null,
      contact_kind: r.contact_kind ?? null,
      housing_terms: r.housing_terms ?? null,
      meals_info: r.meals_info ?? null,
      schedule: r.schedule ?? null,
      status: r.status,
      reject_reason: r.reject_reason ?? null,
      created_at: new Date(r.created_at).toISOString(),
      expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    }));
    send(res, 200, { items });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

/**
 * Apply a moderation decision to an ad and record a learning example. Shared by the
 * admin API endpoint and the bot inline buttons. Returns whether the ad was found.
 */
export async function moderateAd(
  adId: string,
  action: 'approve' | 'reject',
  reason: string | null,
): Promise<{ found: boolean }> {
  const sql = getSql();
  const ttl = await getConfigNumber('user_ad_ttl_days', 14);
  const status: 'approved' | 'rejected' = action === 'approve' ? 'approved' : 'rejected';

  // Only a 'pending' ad can be moderated: this prevents re-approving an 'expired' (or
  // already-decided) ad and silently returning it to the feed. A stale button on an
  // already-handled ad simply resolves to found=false.
  const rows = (await sql`
    update user_ads
    set status = ${status}::user_ad_status,
        moderated_at = now(),
        reject_reason = ${action === 'reject' ? (reason ?? 'rejected') : null},
        expires_at = case when ${status} = 'approved' then now() + make_interval(days => ${ttl}) else expires_at end
    where id = ${adId}::uuid and status = 'pending'
    returning title, description, salary_text, schedule, housing_terms, meals_info`) as unknown as {
    title: string | null;
    description: string | null;
    salary_text: string | null;
    schedule: string | null;
    housing_terms: string | null;
    meals_info: string | null;
  }[];

  const r = rows[0];
  if (!r) return { found: false };

  // Same example context as adsCreate (manual decisions are the most valuable few-shot).
  const text = [r.title, r.description, r.salary_text, r.schedule, r.housing_terms, r.meals_info]
    .filter(Boolean)
    .join('\n');
  await recordModerationExample(text, status === 'approved' ? 'approved' : 'rejected', action === 'reject' ? reason : null);
  return { found: true };
}

interface ModerateBody {
  action?: unknown;
  reason?: unknown;
}

/** POST /api/ads/:id/moderate — ADMIN approve/reject. */
export async function adsModerate(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  const admin = await requireAdmin(req);
  if (!admin.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const id = queryParam(req, 'id');
  if (!id || !UUID_RE.test(id)) return sendError(res, ApiErrorCode.NotFound);

  const body = (await readJsonBody(req)) as ModerateBody | null;
  const action = body?.action === 'approve' || body?.action === 'reject' ? body.action : null;
  if (!action) return sendError(res, ApiErrorCode.BadRequest, "action must be 'approve' or 'reject'");
  const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : null;

  try {
    const { found } = await moderateAd(id, action, reason);
    if (!found) return sendError(res, ApiErrorCode.NotFound);
    send(res, 200, { ok: true });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
