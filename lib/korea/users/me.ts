// lib/korea/users/me.ts
//
// GET /api/me — the caller's public id, language, and current subscription
// (chosen cities + work types + notify). User is resolved from verified initData.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { getConfigString } from '../config.js';
import { readStreakSummary } from '../streaks/update.js';

export async function meGet(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);
  const { user } = auth;

  try {
    const sql = getSql();
    // @neondatabase/serverless parses arrays only for built-in element OIDs. CUSTOM ENUM
    // arrays (work_type[]/visa_type[]) have per-DB dynamic OIDs the driver does not know, so
    // they arrive as the RAW literal "{...}" string, which the Array.isArray guards below
    // collapse to [] (the owner's "no saved filters" bug). Cast them to text[] (OID 1009 is
    // parsed) so the driver returns real JS arrays. city_ids is uuid[] — a BUILT-IN array OID
    // the driver already parses to an array (verified live), so it needs no cast.
    const subRows = (await sql`
      select city_ids, work_types::text[] as work_types, notify, digest_enabled, no_city,
             visa_types::text[] as visa_types, placement_fee, require_housing, require_meals
      from subscriptions where user_id = ${user.id}::uuid limit 1`) as unknown as {
      city_ids: string[] | null;
      work_types: string[] | null;
      notify: boolean;
      digest_enabled: boolean | null;
      no_city: boolean | null;
      visa_types: string[] | null;
      placement_fee: string | null;
      require_housing: boolean | null;
      require_meals: boolean | null;
    }[];

    let citySlugs: string[] = [];
    let workTypes: string[] = [];
    let notify = true;
    // digest_enabled / no_city are `boolean not null default true` (draft_0017 / draft_0020) and
    // absent (no subscription row) means "on" — mirror POST /api/subscription's absent-default AND
    // the client's `s.no_city ?? true`, so a cold GET returns the SAME truth the client stores. When
    // these were missing from the echo the client fell back to `?? true` and silently flipped a
    // user's OFF toggle back ON on cold load (Censor/Olya major). `?? true` keeps null -> on too.
    let digestEnabled = true;
    let noCity = true;
    let visaTypes: string[] = [];
    let placementFee: string | null = null;
    let requireHousing: boolean | null = null;
    let requireMeals: boolean | null = null;

    const sub = subRows[0];
    if (sub) {
      notify = sub.notify === true;
      digestEnabled = sub.digest_enabled ?? true;
      noCity = sub.no_city ?? true;
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

    // Terms: re-consent required when never accepted OR the accepted version is not the
    // current one. Exact-inequality (not `<`) is scheme-agnostic: it stays correct whether
    // versions are ISO dates ("2026-07-15"), "vN", or semver — no fragile lexicographic order.
    const termsRows = (await sql`
      select terms_accepted_at, terms_version, onboarded_at from users where id = ${user.id}::uuid limit 1`) as unknown as {
      terms_accepted_at: string | null;
      terms_version: string | null;
      onboarded_at: string | null;
    }[];
    const currentVersion = await getConfigString('terms_version', 'unversioned');
    const acceptedAt = termsRows[0]?.terms_accepted_at ?? null;
    const acceptedVersion = termsRows[0]?.terms_version ?? null;
    const termsRequired = acceptedAt === null || (acceptedVersion ?? '') !== currentVersion;
    // One-time onboarding gate for the client (users.onboarded_at; POST /api/onboarded).
    const onboarded = (termsRows[0]?.onboarded_at ?? null) !== null;

    // Loyalty balance for the header badge. Truth is DERIVED (no cached column, draft_0004):
    // confirmed referral ledger rows + all streak_awards. readStreakSummary degrades to 0 in a
    // deploy-before-migration window, so the badge never 500s over a missing streak table.
    const balRows = (await sql`
      select coalesce(sum(amount) filter (where status = 'confirmed'), 0)::int as points_total
      from referral_points_ledger where user_id = ${user.id}::uuid`) as unknown as {
      points_total: number;
    }[];
    const streak = await readStreakSummary(sql, user.id);
    const pointsTotal = (balRows[0]?.points_total ?? 0) + streak.bonusTotal;

    send(res, 200, {
      public_id: user.publicId,
      lang: user.lang,
      terms: { required: termsRequired, version: currentVersion },
      points_total: pointsTotal,
      onboarded,
      subscription: {
        city_slugs: citySlugs,
        work_types: workTypes,
        notify,
        digest_enabled: digestEnabled,
        no_city: noCity,
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
