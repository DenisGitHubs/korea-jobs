// lib/korea/users/me.ts
//
// GET /api/me — the caller's public id, language, and current subscription
// (chosen cities + work types + notify). User is resolved from verified initData.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { getConfigString } from '../config.js';

export async function meGet(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);
  const { user } = auth;

  try {
    const sql = getSql();
    const subRows = (await sql`
      select city_ids, work_types, notify, visa_types, placement_fee, require_housing, require_meals
      from subscriptions where user_id = ${user.id}::uuid limit 1`) as unknown as {
      city_ids: string[] | null;
      work_types: string[] | null;
      notify: boolean;
      visa_types: string[] | null;
      placement_fee: string | null;
      require_housing: boolean | null;
      require_meals: boolean | null;
    }[];

    let citySlugs: string[] = [];
    let workTypes: string[] = [];
    let notify = true;
    let visaTypes: string[] = [];
    let placementFee: string | null = null;
    let requireHousing: boolean | null = null;
    let requireMeals: boolean | null = null;

    const sub = subRows[0];
    if (sub) {
      notify = sub.notify === true;
      workTypes = Array.isArray(sub.work_types) ? sub.work_types : [];
      visaTypes = Array.isArray(sub.visa_types) ? sub.visa_types : [];
      placementFee = sub.placement_fee ?? null;
      requireHousing = sub.require_housing ?? null;
      requireMeals = sub.require_meals ?? null;
      const cityIds = Array.isArray(sub.city_ids) ? sub.city_ids : [];
      if (cityIds.length) {
        const slugRows = (await sql`
          select slug from cities where id = any(${cityIds}::uuid[]) order by sort_order`) as unknown as {
          slug: string;
        }[];
        citySlugs = slugRows.map((r) => r.slug);
      }
    }

    // Terms: re-consent required when never accepted OR accepted an older version.
    const termsRows = (await sql`
      select terms_accepted_at, terms_version from users where id = ${user.id}::uuid limit 1`) as unknown as {
      terms_accepted_at: string | null;
      terms_version: string | null;
    }[];
    const currentVersion = await getConfigString('terms_version', 'unversioned');
    const acceptedAt = termsRows[0]?.terms_accepted_at ?? null;
    const acceptedVersion = termsRows[0]?.terms_version ?? null;
    const termsRequired = acceptedAt === null || (acceptedVersion ?? '') < currentVersion;

    send(res, 200, {
      public_id: user.publicId,
      lang: user.lang,
      terms: { required: termsRequired, version: currentVersion },
      subscription: {
        city_slugs: citySlugs,
        work_types: workTypes,
        notify,
        visa_types: visaTypes,
        placement_fee: placementFee,
        require_housing: requireHousing,
        require_meals: requireMeals,
      },
    });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
