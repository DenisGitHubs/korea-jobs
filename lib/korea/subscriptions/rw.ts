// lib/korea/subscriptions/rw.ts
//
// POST /api/subscription — save the caller's chosen cities + work types + notify
// toggle. One row per user (unique user_id). User is resolved from verified initData
// (007: user_id NEVER from the request body). Invalid slugs/work_types are dropped.
//
// notify_daily_cap (owner, 2026-07-26) — how many notification DMs a day the person wants.
// Owner's rule: EVERYONE is unlimited by default; a limit exists only because someone chose it in
// the settings. This endpoint REPLACES the whole row on conflict, which is exactly the wrong default
// for a field an older client does not know about: an absent value would silently LIFT someone's
// limit. So this one column uses keep-on-absent semantics (the coalesce pattern, spelled out as a
// CASE because the "no limit" choice is itself a NULL and must stay tellable apart from "the client
// said nothing"):
//   absent  -> keep the stored value; a brand-new row is created with NULL = no limit
//   null/0  -> "без ограничения" -> stored NULL
//   1..500  -> stored as-is
//   anything else -> 400 bad_request (see lib/korea/notify/cap.ts for the reasoning)
// Requires draft_0026_notify_daily_cap.sql to be applied first.

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
import { parseNotifyDailyCap } from '../notify/cap.js';

const WORK_TYPE_SET = new Set<string>(WORK_TYPES);
const VISA_TYPE_SET = new Set<string>(VISA_TYPES);
const PLACEMENT_FEE_SET = new Set<string>(PLACEMENT_FEES);

interface Body {
  city_slugs?: unknown;
  region_slugs?: unknown;
  work_types?: unknown;
  notify?: unknown;
  notify_daily_cap?: unknown;
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
  // How many notification DMs a day this person wants. STRICT: a present-but-malformed value is a
  // client bug or tampering, and quietly rounding it would change how much mail someone gets without
  // them knowing — so it fails the request instead. `capParam` is the value bound to SQL below:
  // null = "the field was absent" (keep / use the column default), 0 = explicit "no limit".
  const parsedCap = parseNotifyDailyCap(body?.notify_daily_cap);
  if (!parsedCap.ok) return sendError(res, ApiErrorCode.BadRequest);
  const capParam = parsedCap.param;

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

    // notify_daily_cap is the ONE column that is not a blind overwrite (see the file header):
    //   * INSERT  — plain `nullif($cap, 0)`: an ABSENT field (bound as null) stores SQL NULL and an
    //               explicit "no limit" (bound as 0) stores SQL NULL too, so a brand-new subscriber
    //               is UNLIMITED unless they picked a number — the owner's rule, and the reason
    //               there is no column DEFAULT to fall back on.
    //   * UPDATE  — a CASE, because here the two cases must diverge: the absent branch keeps
    //               subscriptions.notify_daily_cap (this is `coalesce(excluded.x, subscriptions.x)`
    //               written out longhand; coalesce alone cannot express it because "no limit" is
    //               itself NULL and would be indistinguishable from "field absent").
    // RETURNING gives the value actually stored, so the echo can never disagree with the DB.
    const saved = (await sql`
      insert into subscriptions (
        user_id, city_ids, region_slugs, work_types, notify, digest_enabled, no_city,
        visa_types, placement_fee, require_housing, require_meals, notify_daily_cap
      )
      values (
        ${user.id}::uuid, ${cityIds}::uuid[], ${validRegions}::text[], ${workTypes}::work_type[], ${notify}, ${digestEnabled}, ${noCity},
        ${visaTypes}::visa_type[], ${placementFee}::placement_fee, ${requireHousing}, ${requireMeals},
        nullif(${capParam}::int, 0)
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
        notify_daily_cap = case
          when ${capParam}::int is null then subscriptions.notify_daily_cap
          else nullif(${capParam}::int, 0)
        end,
        updated_at = now()
      returning notify_daily_cap`) as unknown as { notify_daily_cap: number | null }[];

    // Echo what the DB now holds. The fallback (no rows — unreachable against a real database, since
    // RETURNING always yields the upserted row) degrades to what the CALLER asked for: 0 -> null.
    const requestedCap = capParam === null ? null : capParam || null;
    const notifyDailyCap = saved.length ? (saved[0]?.notify_daily_cap ?? null) : requestedCap;

    send(res, 200, {
      city_slugs: validSlugs,
      region_slugs: validRegions,
      work_types: workTypes,
      notify,
      notify_daily_cap: notifyDailyCap,
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
