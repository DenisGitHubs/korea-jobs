// lib/korea/subscriptions/rw.ts
//
// POST /api/subscription — save the caller's chosen cities + work types + notify
// toggle. One row per user (unique user_id). User is resolved from verified initData
// (007: user_id NEVER from the request body). Invalid slugs/work_types are dropped.

import { getSql } from '../core/db.js';
import {
  type ReqLike,
  type ResLike,
  send,
  sendError,
  readJsonBody,
} from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { WORK_TYPES } from '../parser/prompt.js';

const WORK_TYPE_SET = new Set<string>(WORK_TYPES);

interface Body {
  city_slugs?: unknown;
  work_types?: unknown;
  notify?: unknown;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export async function subscriptionPost(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);
  const { user } = auth;

  const body = (await readJsonBody(req)) as Body | null;
  const inSlugs = stringArray(body?.city_slugs);
  const workTypes = stringArray(body?.work_types).filter((w) => WORK_TYPE_SET.has(w));
  const notify = body?.notify === undefined ? true : body?.notify === true;

  try {
    const sql = getSql();
    // Keep only real, active cities; canonical order for the echo.
    const cityRows = (await sql`
      select id, slug from cities where slug = any(${inSlugs}::text[]) and is_active = true order by sort_order`) as unknown as {
      id: string;
      slug: string;
    }[];
    const cityIds = cityRows.map((r) => r.id);
    const validSlugs = cityRows.map((r) => r.slug);

    await sql`
      insert into subscriptions (user_id, city_ids, work_types, notify)
      values (${user.id}::uuid, ${cityIds}::uuid[], ${workTypes}::work_type[], ${notify})
      on conflict (user_id) do update set
        city_ids = excluded.city_ids,
        work_types = excluded.work_types,
        notify = excluded.notify,
        updated_at = now()`;

    send(res, 200, { city_slugs: validSlugs, work_types: workTypes, notify });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
