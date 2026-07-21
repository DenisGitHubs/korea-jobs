// lib/korea/cities/read.ts
//
// GET /api/cities — ALL active cities (full 167-city directory) for the filter/picker screen.
// initData-authed like every user endpoint; non-sensitive reference data (slug + localized name +
// region). This list is intentionally UNFILTERED: the picker needs every city (canonical + the new
// dictionary rows), unlike the AI parser/moderation prompt, which is pinned to the canonical 31
// (sort_order < 1000; see run.ts / ads/moderation.ts). Do NOT add a sort_order filter here.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';

export async function citiesGet(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  try {
    const sql = getSql();
    const rows = await sql`
      select slug, name, region_slug from cities where is_active = true order by sort_order`;
    send(
      res,
      200,
      rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        region_slug: (r.region_slug as string | null) ?? null,
      })),
    );
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
