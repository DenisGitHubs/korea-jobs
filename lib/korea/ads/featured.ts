// lib/korea/ads/featured.ts
//
// FEATURED placements («избранные», owner decision 2026-10-21) — the SINGLE implementation of
// the whole rule. An ad posted THROUGH OUR FORM that passes the filters and moderation is lifted
// to the TOP of the feed for one week. Placement is FREE: there is no payment in this project and
// none is being introduced.
//
// 🔴 THE WEEK IS A POSITION, NOT A MARK (Законник, 2026-10-21 — this replaced the first version of
// the decision, where the badge rode along with the lift). The app's «От автора» badge is drawn
// from `source_kind === 'user'` and belongs to EVERY self-placed ad, for good, whether or not its
// week is running; the client does not read `featured` at all. Reason: a badge that arrives and
// leaves together with a privilege inevitably reads as "trust this one more", while a badge on
// every self-placed ad states where the ad came from. So everything in this file is about ORDER.
//
// 🔴 THE WEEK RESTS ON THE CONFIRMATION «Я НЕ БЕРУ ПЛАТУ С РАБОТНИКОВ» (owner 2026-10-21, after
// 007/m4). The lift is granted ONLY to a row that has `no_worker_fee_confirmed_at` on file
// (draft_0035). That means ads created BEFORE the rule — and anything that was waiting in
// moderation when it shipped — DO NOT get the week, and editing such an ad does not earn it either.
// This is deliberate, not a bug: the grant is also called from the edit / unarchive / manual-approve
// paths, so without that condition an old unconfirmed ad would have collected the privilege simply
// by being saved again, and the checkbox would have meant nothing for exactly the ads it exists for.
// Such an ad still PUBLISHES normally — it is an ordinary card with no privilege. Do not "fix" this.
//
// 🔴 THIS IS NOT user_ads.promo (draft_0030) AND MUST NEVER BE FOLDED INTO IT.
//   promo          = a PAID placement, labelled «Реклама» on screen, deliberately WITHOUT any
//                    ranking privilege and never pushed to a DM.
//   featured_until = a FREE placement that IS lifted for 7 days and is NOT labelled «Реклама»
//                    (calling a free ad "advertising" would be a lie on the screen). It carries no
//                    label of its own either — see the note above.
// They are separate columns because they mean opposite things. A promo row is never granted the
// free week (the guard is in the UPDATE below), and nothing here reads or writes promo.
//
// WHERE THE RULE LIVES
//   * the GRANT (now + N days, one per ad, one live per author) — this file, one UPDATE;
//   * the READ ("is it featured right now") — featuredLiveSql(), the ONE expression used by the
//     feed's ORDER BY and by every feed/detail/saved projection, so the sort key and the cursor
//     that pages over it can never disagree. Nothing on the screen hangs on it;
//   * the EXPIRY — nobody's job: the comparison with now() in featuredLiveSql IS the expiry, so
//     cleanup/run.ts needs no sweep and there is no second flag to keep in sync.
//
// The grant is BEST-EFFORT by contract: an ad must never be lost because the perk could not be
// written (e.g. draft_0033 is not applied yet). It logs and returns false instead of throwing.

import type { getSql } from '../core/db.js';
import { getConfigNumber } from '../config.js';
import { findGenderHints } from '../core/discrimination.js';

/** How long a granted week lasts. The owner's number; tunable via config without a deploy. */
export const FEATURED_DAYS_DEFAULT = 7;
/** Config key holding FEATURED_DAYS_DEFAULT (seeded by draft_0033). */
export const FEATURED_DAYS_KEY = 'ads_featured_days';

/**
 * SQL boolean — "is THIS user_ads row featured right now", i.e. the feed's SORT KEY. `alias` is the
 * user_ads alias in the surrounding query (`a` everywhere in vacancies/read.ts). No badge is drawn
 * from it: the client never reads the field (see the header and the CONTRACT note in read.ts).
 *
 * The column is read through `to_jsonb(<alias>) ->> 'featured_until'` ON PURPOSE — the same
 * pattern draft_0030 established for media_id / promo: the feed is the app's main screen, and
 * naming a not-yet-migrated column there would turn a deploy-before-migrate window into a total
 * feed outage. A missing key yields NULL -> coalesce -> false -> today's behaviour, no error.
 *
 * NOTE: the date itself NEVER leaves the server — callers select this BOOLEAN, never featured_until.
 */
export function featuredLiveSql(alias: string): string {
  return `coalesce(((to_jsonb(${alias}) ->> 'featured_until')::timestamptz) > now(), false)`;
}

/**
 * 🔴 A GENDER-RESTRICTED AD NEVER GETS THE LIFT (Законник, 2026-10-21).
 *
 * While an offer merely passes through from somebody else's channel we are relaying it. A card WE
 * placed through our own form and WE pushed to the top of the feed by our own mechanics has no such
 * excuse, and distributing a vacancy with a gender restriction is punishable in RU. So: a text that
 * limits the audience by gender is published as an ORDINARY ad — nothing breaks, it simply gets no
 * privilege. Screening is on the TEXT because there is nothing else to screen: the ad form has no
 * "who is wanted" field and user_ads has no gender column (the feed reports 'any' for every ad) —
 * the vocabulary is the shared one in core/discrimination.ts. Refusing the bonus on a match is the
 * cheap side of the mistake; granting it is not.
 *
 * 🔴 OPEN, NOT DONE (do not read this as a finished loop): THE AUTHOR IS NEVER TOLD. The only
 * warning about such phrases that exists today is in the OWNER'S BOT preview of /post
 * (scheduled/parse.ts, his own scheduled posts) — the Mini App's placement form shows the author
 * nothing, so a person loses the week silently and cannot know why. Telling the author is a
 * separate piece of work, handed to the owner (2026-10-21); nothing here depends on it.
 */
function genderRestricted(adText: string): boolean {
  return findGenderHints(adText).length > 0;
}

/**
 * Grant the free featured week to an ad that has just become APPROVED through our form.
 *
 * ONE atomic UPDATE carries every condition, so two approvals of the same author racing each other
 * cannot both win (a read-then-write would let them):
 *   * status = 'approved'        — only a published ad is ever lifted;
 *   * featured_until is null     — AT MOST ONCE per ad, ever: an edit / archive→unarchive cycle can
 *                                  never renew the week (and makes this call idempotent);
 *   * author_user_id is not null — an orphaned ad (author erased) has no author to cap, so skip it;
 *   * not promo                  — a PAID placement is never given the free privilege (draft_0030:
 *                                  promo gets no ranking advantage at all);
 *   * NOT EXISTS (another ad of the SAME author with featured_until > now()) — 🔴 ONE LIVE FEATURED
 *     PER AUTHOR (owner 2026-10-21): while the first week is alive, the author's next ad is
 *     published as an ORDINARY one, so one employer cannot occupy the whole top of the feed.
 *     The cap counts ANY row of that author whose week is still running — including an archived or
 *     expired one. That is deliberate: counting only feed-visible rows would let an author archive
 *     a featured ad, get a second week on a new ad, and then unarchive the first — two at the top.
 *
 * Returns whether the week was actually granted (false = capped, already granted, or a soft fault).
 * Callers do not branch on it; it exists so the caller CAN log/report and so tests can read it.
 */
export async function grantFeaturedOnApproval(
  sql: ReturnType<typeof getSql>,
  adId: string,
  adText: string,
): Promise<boolean> {
  // 🔴 The gender gate comes FIRST and costs no query: a restricted ad is never lifted. `adText` is
  // a REQUIRED argument on purpose — a route that forgets to pass the ad's own text does not
  // compile, so the gate cannot be skipped by omission.
  if (genderRestricted(adText)) {
    // Count only — the matched phrase is part of a person's ad text and never goes into a log.
    // eslint-disable-next-line no-console
    console.log('[ads] featured refused: gender-restricted text, phrases=%d', findGenderHints(adText).length);
    return false;
  }
  try {
    const days = await getConfigNumber(FEATURED_DAYS_KEY, FEATURED_DAYS_DEFAULT);
    // The deadline is computed by POSTGRES (now() + make_interval), exactly like the sibling
    // expires_at in ads/rw.ts — one clock for both lifetimes of the same row.
    const rows = (await sql`
      update user_ads t
      set featured_until = now() + make_interval(days => ${days})
      where t.id = ${adId}::uuid
        and t.status = 'approved'
        and t.featured_until is null
        and t.author_user_id is not null
        and not coalesce(t.promo, false)
        -- 🔴 NO CONFIRMATION, NO WEEK (owner 2026-10-21, found by 007/m4). This UPDATE is reached
        -- from the EDIT, the UNARCHIVE and the manual approve too — paths that act on rows created
        -- BEFORE «Я не беру плату с работников» existed (no_worker_fee_confirmed_at IS NULL) and on
        -- everything that was sitting in moderation when the rule shipped. Without this line an old
        -- ad earned the lift just by being edited, and the checkbox would have meant nothing for
        -- exactly the ads it was introduced for. The ad still PUBLISHES — it only gets no privilege.
        and t.no_worker_fee_confirmed_at is not null
        and not exists (
          select 1 from user_ads o
          where o.author_user_id = t.author_user_id
            and o.id <> t.id
            and o.featured_until is not null
            and o.featured_until > now())
      returning t.id`) as unknown as { id: string }[];
    return rows.length > 0;
  } catch (err) {
    // Best-effort by contract (see the header): the ad itself is already published; losing the
    // perk is a cosmetic loss, losing the ad would not be. Log the MESSAGE only (never the text
    // or contacts) so a missing migration is diagnosable instead of silent.
    // eslint-disable-next-line no-console
    console.error('[ads] featured grant failed (best-effort):', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * 🔴 TAKE THE LIFT AWAY ON THE FIRST COMPLAINT, AND LEAVE THE AD ALONE (Законник, 2026-10-21).
 *
 * A complaint about a card withdraws its free top-of-feed position and its badge immediately, while
 * the card itself stays live and visible until a human has looked at it. That asymmetry is the
 * point: the lift is a free bonus we grant by our own mechanics, so withdrawing it promises nothing
 * to anybody — REMOVING an ad is a different decision and belongs to a human. And it must be
 * MECHANICS, not somebody editing a row by hand.
 *
 * WHY IT WRITES now() AND NOT NULL. "Expire it now" kills the lift exactly like NULL would (the
 * feed asks `featured_until > now()`), and it keeps the ad's history: NULL means "never featured",
 * which is also the condition that allows a GRANT. Blanking it would hand the author a loophole —
 * get lifted, get reported, edit the ad, get lifted again. A past deadline ends the week for good
 * while still releasing the author's one-live-featured slot (the cap only counts live weeks).
 *
 * Idempotent (an already-expired or never-granted ad simply matches nothing) and best-effort: a
 * complaint must be recorded even if this write fails.
 */
export async function revokeFeaturedOnReport(
  sql: ReturnType<typeof getSql>,
  adId: string,
): Promise<boolean> {
  try {
    const rows = (await sql`
      update user_ads set featured_until = now()
      where id = ${adId}::uuid and featured_until is not null and featured_until > now()
      returning id`) as unknown as { id: string }[];
    return rows.length > 0;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[ads] featured revoke failed (best-effort):', err instanceof Error ? err.message : String(err));
    return false;
  }
}
