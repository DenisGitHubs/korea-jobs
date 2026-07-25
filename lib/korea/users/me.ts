// lib/korea/users/me.ts
//
// GET /api/me — the caller's public id, language, and current subscription
// (chosen cities + work types + notify). User is resolved from verified initData.
//
// MAILING IS OPT-IN (owner rule 2026-07-25): a caller with NO subscription row gets nothing from
// either cron (both INNER JOIN subscriptions), so this endpoint reports notify=false /
// digest_enabled=false for them — the settings screen must not show an enabled toggle for mail
// that is never sent. `no_city` is NOT a mailing switch and keeps its true default.
//
// Also carries `flags` — server-side switches the client needs to render correctly (currently only
// hide_unverified, the «Не проверено» kill-switch; enforcement itself lives in raw/read.ts).

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { getConfigString, getConfigNumber, getConfigBool } from '../config.js';
import { readStreakSummary } from '../streaks/update.js';
import { reveals24h } from '../vacancies/read.js';

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
    //
    // notify_daily_cap (draft_0026) is read through to_jsonb(s) so this endpoint keeps working on a
    // database where the migration has not landed yet: an unknown key yields NULL, which is exactly
    // the column's "no limit" meaning and today's behaviour — /me can never 500 over the new field.
    const subRows = (await sql`
      select s.city_ids, s.region_slugs, s.work_types::text[] as work_types, s.notify, s.digest_enabled, s.no_city,
             s.visa_types::text[] as visa_types, s.placement_fee, s.require_housing, s.require_meals,
             (to_jsonb(s) ->> 'notify_daily_cap')::int as notify_daily_cap
      from subscriptions s where s.user_id = ${user.id}::uuid limit 1`) as unknown as {
      city_ids: string[] | null;
      region_slugs: string[] | null;
      work_types: string[] | null;
      notify: boolean;
      digest_enabled: boolean | null;
      no_city: boolean | null;
      visa_types: string[] | null;
      placement_fee: string | null;
      require_housing: boolean | null;
      require_meals: boolean | null;
      notify_daily_cap: number | null;
    }[];

    let citySlugs: string[] = [];
    let regionSlugs: string[] = [];
    let workTypes: string[] = [];
    // MAILING IS OPT-IN (owner rule 2026-07-25). A user with NO subscription row receives NOTHING
    // (both notify/run.ts and digest/run.ts INNER JOIN subscriptions), so reporting notify/digest as
    // "on" was a lie: the settings screen showed enabled toggles while no mail was ever sent. The
    // honest cold value is OFF — the same absent-means-off rule POST /api/subscription now applies.
    let notify = false;
    let digestEnabled = false;
    // no_city is NOT a mailing switch: it is a FEED/geo widening rule ("also show offers with no
    // city"), `boolean not null default true` (draft_0020). Its absent-default stays TRUE, mirroring
    // POST /api/subscription and the client's `s.no_city ?? true`, so a cold GET returns the SAME
    // truth the client stores (when it was missing from the echo the client's `?? true` silently
    // flipped a user's OFF toggle back ON on cold load — Censor/Olya major).
    let noCity = true;
    let visaTypes: string[] = [];
    let placementFee: string | null = null;
    let requireHousing: boolean | null = null;
    let requireMeals: boolean | null = null;
    // How many notification DMs a day this person receives (LETTERS, not vacancies; null = no limit).
    // COLD value (no subscription row) is null = «без ограничения» — the owner's rule is that nobody
    // is limited until they choose a number, and POST /api/subscription creates a fresh row with NULL
    // too, so the settings screen shows exactly what a save would store.
    let notifyDailyCap: number | null = null;

    const sub = subRows[0];
    if (sub) {
      notify = sub.notify === true;
      // A stored NULL is "no limit": either the chosen «без ограничения» or simply the untouched
      // state of a row nobody has limited (the migration adds no default and backfills nobody).
      notifyDailyCap = sub.notify_daily_cap ?? null;
      // Opt-in semantics all the way down: a NULL digest flag (only possible in a
      // deploy-before-migration window) reads as OFF, never as on.
      digestEnabled = sub.digest_enabled === true;
      noCity = sub.no_city ?? true;
      // region_slugs is text[] (built-in OID, driver-parsed): stored slugs, echoed straight back.
      regionSlugs = Array.isArray(sub.region_slugs) ? sub.region_slugs : [];
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

    // Contact reveals remaining TODAY = cap(contact_reveal_daily_cap, 50) − reveals in the last 24h
    // (the SAME shared budget as GET /api/vacancies/:id/contact + /api/raw/reveal). Best-effort like
    // readStreakSummary above: a fault degrades to the FULL budget (used=0) so /me never 500s over it.
    const revealCap = await getConfigNumber('contact_reveal_daily_cap', 50);
    let revealsUsed = 0;
    try {
      revealsUsed = await reveals24h(sql, user.id);
    } catch {
      /* best-effort: show the full budget rather than fail the whole /me response */
    }
    const revealsLeft = Math.max(0, revealCap - revealsUsed);

    // Server-side feature flags the CLIENT needs to render correctly. hide_unverified (config,
    // default false) is the owner's kill-switch for the «Не проверено» stream: when it is on the
    // server already returns an EMPTY GET /api/raw and 404s POST /api/raw/reveal (raw/read.ts,
    // raw/reveal.ts — the enforcement never depends on the client), and this flag lets the app hide
    // the tab entirely instead of showing an always-empty one. Additive field: an older client that
    // does not read `flags` keeps working (it just shows an empty tab).
    const hideUnverified = await getConfigBool('hide_unverified', false);

    send(res, 200, {
      public_id: user.publicId,
      lang: user.lang,
      terms: { required: termsRequired, version: currentVersion },
      points_total: pointsTotal,
      reveals_left: revealsLeft,
      onboarded,
      flags: { hide_unverified: hideUnverified },
      subscription: {
        city_slugs: citySlugs,
        region_slugs: regionSlugs,
        work_types: workTypes,
        notify,
        notify_daily_cap: notifyDailyCap,
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
