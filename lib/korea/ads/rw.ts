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
import { adminRecipients } from '../admin/auth.js';
import { recordModerationExample, decideAdModeration } from './moderation.js';
import { parseAdInput, adModText, UUID_RE, type AdBody } from './input.js';

/** Notify admins about a pending ad with inline Approve/Reject buttons. Recipients =
 *  env ADMIN_TELEGRAM_IDS ∪ users.role='admin'. Empty list → silent (unchanged). */
export async function notifyAdminsPending(
  sql: ReturnType<typeof getSql>,
  adId: string,
  summary: string,
): Promise<void> {
  const ids = await adminRecipients(sql);
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

  const parsed = parseAdInput((await readJsonBody(req)) as AdBody | null);
  if (!parsed.ok) return sendError(res, ApiErrorCode.BadRequest, parsed.error);
  const f = parsed.fields;

  // Moderation text (title + description + extras). This is DATA, never an instruction.
  const modText = adModText(f.title, f.description, f.salaryText, f.schedule, f.housingTerms, f.mealsInfo);
  // Deterministic ad-spam backstop + AI classifier + config thresholds — the SINGLE decision,
  // shared with edit/unarchive so all three routes agree on approve/pending/reject.
  const { status, rejectReason, item, cityIdBySlug, aiConfidence } = await decideAdModeration(modText);

  // Resolve city: user's directory pick wins; else the AI-picked slug. city_text (the free
  // "Другое" city) is kept ONLY when nothing resolved a city_id — the two are exclusive.
  const citySlug = (f.reqCitySlug && cityIdBySlug.has(f.reqCitySlug) ? f.reqCitySlug : null) ?? item?.city_slug ?? null;
  const cityId = citySlug ? cityIdBySlug.get(citySlug) ?? null : null;
  const cityText = cityId ? null : f.reqCityText;
  const regionSlug = f.reqRegion ?? item?.region_slug ?? null;

  const ttl = await getConfigNumber('user_ad_ttl_days', 14);

  try {
    const sql = getSql();
    const rows = (await sql`
      insert into user_ads (
        author_user_id, city_id, city_text, region_slug, work_type, visa_types, placement_fee,
        has_housing, has_meals, salary_text, title, description, contact_raw, contact_kind,
        housing_terms, meals_info, schedule, status, moderated_at, reject_reason, ai_confidence,
        expires_at, notify_pending
      ) values (
        ${auth.user.id}::uuid, ${cityId}::uuid, ${cityText}, ${regionSlug}, ${f.workType}::work_type,
        ${f.visaTypes}::visa_type[], ${f.placementFee}::placement_fee,
        ${f.hasHousing}, ${f.hasMeals}, ${f.salaryText}, ${f.title}, ${f.description}, ${f.contactRaw}, ${f.contactKind}::contact_kind,
        ${f.housingTerms}, ${f.mealsInfo}, ${f.schedule},
        ${status}::user_ad_status,
        case when ${status} = 'pending' then null else now() end,
        ${rejectReason}, ${aiConfidence},
        case when ${status} = 'approved' then now() + make_interval(days => ${ttl}) else null end,
        case when ${status} = 'approved' then true else false end
      )
      returning id`) as unknown as { id: string }[];
    const id = rows[0]?.id;

    // Record the automatic decision for learning (only the clear-cut auto outcomes).
    if (id && status !== 'pending') {
      await recordModerationExample(modText, status === 'approved' ? 'approved' : 'rejected', rejectReason);
    }
    // Pending → push to admins for a manual call.
    if (id && status === 'pending') {
      const summary = [citySlug ?? cityText ?? regionSlug ?? '—', f.workType, f.title].filter(Boolean).join(' · ');
      await notifyAdminsPending(sql, id, summary);
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
  city_text: string | null;
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
  bumped_at: string | null;
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
      select a.id, c.slug as city_slug, c.name as city_name, a.city_text, a.region_slug, a.work_type,
             a.visa_types::text[] as visa_types, a.placement_fee, a.has_housing, a.has_meals, a.salary_text,
             a.title, a.description, a.contact_raw, a.contact_kind,
             a.housing_terms, a.meals_info, a.schedule, a.status, a.reject_reason,
             a.created_at, a.bumped_at, a.expires_at
      from user_ads a
      left join cities c on c.id = a.city_id
      where a.author_user_id = ${auth.user.id}::uuid
      order by a.created_at desc
      limit 100`) as unknown as AdRow[];

    const items = rows.map((r) => ({
      id: r.id,
      city: r.city_slug ? { slug: r.city_slug, name: r.city_name } : null,
      city_text: r.city_text ?? null,
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
      bumped_at: r.bumped_at ? new Date(r.bumped_at).toISOString() : null,
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
        expires_at = case when ${status} = 'approved' then now() + make_interval(days => ${ttl}) else expires_at end,
        notify_pending = case when ${status} = 'approved' then true else notify_pending end
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
