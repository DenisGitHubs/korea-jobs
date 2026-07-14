// lib/korea/users/me.ts
//
// GET /api/me — the caller's public id, language, and current subscription
// (chosen cities + work types + notify). User is resolved from verified initData.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';

export async function meGet(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);
  const { user } = auth;

  try {
    const sql = getSql();
    const subRows = (await sql`
      select city_ids, work_types, notify from subscriptions where user_id = ${user.id}::uuid limit 1`) as unknown as {
      city_ids: string[] | null;
      work_types: string[] | null;
      notify: boolean;
    }[];

    let citySlugs: string[] = [];
    let workTypes: string[] = [];
    let notify = true;

    const sub = subRows[0];
    if (sub) {
      notify = sub.notify === true;
      workTypes = Array.isArray(sub.work_types) ? sub.work_types : [];
      const cityIds = Array.isArray(sub.city_ids) ? sub.city_ids : [];
      if (cityIds.length) {
        const slugRows = (await sql`
          select slug from cities where id = any(${cityIds}::uuid[]) order by sort_order`) as unknown as {
          slug: string;
        }[];
        citySlugs = slugRows.map((r) => r.slug);
      }
    }

    send(res, 200, {
      public_id: user.publicId,
      lang: user.lang,
      subscription: { city_slugs: citySlugs, work_types: workTypes, notify },
    });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
