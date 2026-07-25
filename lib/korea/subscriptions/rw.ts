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
import { WORK_TYPES, VISA_TYPES, PLACEMENT_FEES } from '../parser/prompt.js';

const WORK_TYPE_SET = new Set<string>(WORK_TYPES);
const VISA_TYPE_SET = new Set<string>(VISA_TYPES);
const PLACEMENT_FEE_SET = new Set<string>(PLACEMENT_FEES);

interface Body {
  city_slugs?: unknown;
  region_slugs?: unknown;
  work_types?: unknown;
  notify?: unknown;
  digest_enabled?: unknown;
  no_city?: unknown;
  visa_types?: unknown;
  placement_fee?: unknown;
  require_housing?: unknown;
  require_meals?: unknown;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function triState(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

export async function subscriptionPost(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);
  const { user } = auth;

  const body = (await readJsonBody(req)) as Body | null;
  const inSlugs = stringArray(body?.city_slugs);
  const inRegions = stringArray(body?.region_slugs);
  const workTypes = stringArray(body?.work_types).filter((w) => WORK_TYPE_SET.has(w));
  // MAILING IS OPT-IN (owner rule 2026-07-25): nothing may be "already on" that the user did not
  // explicitly turn on. An ABSENT notify/digest_enabled is therefore OFF, not on. This also fixes the
  // live bug where a client that omitted digest_enabled silently opted the user INTO the daily digest
  // even with notify=false (the digest run does not look at notify — digest/run.ts).
  const notify = body?.notify === true;
  // digest_enabled: the once-a-day summary opt-in (separate from realtime `notify`). Mirrors
  // notify — absent means OFF, so the client must always send the current toggle.
  const digestEnabled = body?.digest_enabled === true;
  // no_city (MULTI-CITY): when the user HAS picked cities, whether to ALSO see city-less offers.
  // NOT a mailing switch — it WIDENS what the user sees, so it deliberately does NOT follow the
  // opt-in rule above: absent still defaults to TRUE (dropping it to false would silently NARROW an
  // existing user's feed). Ignored server-side when no city is chosen (kj_geo_match returns all).
  // Fed to the feed (buildFilterWhere) + the digest (has_filters).
  const noCity = body?.no_city === undefined ? true : body?.no_city === true;
  const visaTypes = [...new Set(stringArray(body?.visa_types).filter((v) => VISA_TYPE_SET.has(v)))];
  const placementFee =
    typeof body?.placement_fee === 'string' && PLACEMENT_FEE_SET.has(body.placement_fee) && body.placement_fee !== 'unknown'
      ? body.placement_fee
      : null;
  const requireHousing = triState(body?.require_housing);
  const requireMeals = triState(body?.require_meals);

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

    // Keep only REAL region slugs (those that exist on some active city) — the DB whitelist for regions,
    // mirroring the city-slug validation above. An unknown region is silently dropped (never stored).
    const regionRows = (await sql`
      select distinct region_slug from cities
      where region_slug = any(${inRegions}::text[]) and is_active = true and region_slug is not null
      order by region_slug`) as unknown as { region_slug: string }[];
    const validRegions = regionRows.map((r) => r.region_slug);

    await sql`
      insert into subscriptions (
        user_id, city_ids, region_slugs, work_types, notify, digest_enabled, no_city,
        visa_types, placement_fee, require_housing, require_meals
      )
      values (
        ${user.id}::uuid, ${cityIds}::uuid[], ${validRegions}::text[], ${workTypes}::work_type[], ${notify}, ${digestEnabled}, ${noCity},
        ${visaTypes}::visa_type[], ${placementFee}::placement_fee, ${requireHousing}, ${requireMeals}
      )
      on conflict (user_id) do update set
        city_ids = excluded.city_ids,
        region_slugs = excluded.region_slugs,
        work_types = excluded.work_types,
        notify = excluded.notify,
        digest_enabled = excluded.digest_enabled,
        no_city = excluded.no_city,
        visa_types = excluded.visa_types,
        placement_fee = excluded.placement_fee,
        require_housing = excluded.require_housing,
        require_meals = excluded.require_meals,
        updated_at = now()`;

    send(res, 200, {
      city_slugs: validSlugs,
      region_slugs: validRegions,
      work_types: workTypes,
      notify,
      digest_enabled: digestEnabled,
      no_city: noCity,
      visa_types: visaTypes,
      placement_fee: placementFee,
      require_housing: requireHousing,
      require_meals: requireMeals,
    });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
