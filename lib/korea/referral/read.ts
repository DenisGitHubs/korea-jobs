// lib/korea/referral/read.ts
//
// GET /api/referral — the invite screen's data. Scope is ALWAYS the authenticated user
// (context.ts) — never the request body/query (007: the only barrier against cross-user
// leakage on Neon). Response shape is the frozen contract with the Mini App
// (app/src/shared/types/api.ts → ReferralView):
//   { code, link, points_total, points_pending, levels: [{level,invited,points} x3] }
//
//   * code           = the caller's public_id (their referral code).
//   * link           = canonical Mini App deep link, MINTED SERVER-SIDE.
//   * points_total   = confirmed balance (truth = sum of confirmed ledger rows; a confirmed
//                      row's amount is already the EFFECTIVE credit after L1 diminish/wall).
//   * points_pending = credits still inside the anti-fraud hold, PROJECTED through the same
//                      L1 banding the confirm cron will apply — so a farmed L1 tail beyond
//                      the wall shows as 0 here instead of a misleading full amount.
//   * levels         = per-tier invited count (users.referred_by/ref_l2/ref_l3 = me) and
//                      confirmed points earned from that tier.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { getConfigNumber, getConfigString } from '../config.js';

/**
 * Build the canonical Mini App deep link `https://t.me/<bot>/<app>?startapp=<code>`.
 * bot username + app short-name come from config (`referral_bot_username`,
 * `referral_app_shortname`) or the matching env vars.
 *
 * TODO (open item — see draft_0004_referral.sql): until those are set, fall back to APP_URL
 * with the code as a startapp query. That URL is NOT a proper t.me deep link, so the share
 * flow will not auto-open the Mini App — set the config/env once the bot + short-name are
 * final. This is intentional and flagged rather than hardcoding a bot name here.
 */
async function buildReferralLink(code: string): Promise<string> {
  const bot = process.env.REFERRAL_BOT_USERNAME || (await getConfigString('referral_bot_username', ''));
  const app = process.env.REFERRAL_APP_SHORTNAME || (await getConfigString('referral_app_shortname', ''));
  if (bot && app) {
    return `https://t.me/${bot}/${app}?startapp=${encodeURIComponent(code)}`;
  }
  const appUrl = process.env.APP_URL ?? '';
  const sep = appUrl.includes('?') ? '&' : '?';
  return appUrl ? `${appUrl}${sep}startapp=${encodeURIComponent(code)}` : `?startapp=${encodeURIComponent(code)}`;
}

/** GET /api/referral — invite code/link, loyalty balance, per-tier counters. */
export async function referralGet(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);
  const me = auth.user.id;

  try {
    const sql = getSql();
    const [l1FullCount, l1HardCap, dimNum, dimDen, l2l3Cap] = await Promise.all([
      getConfigNumber('referral_l1_full_count', 20),
      getConfigNumber('referral_l1_hard_cap', 100),
      getConfigNumber('referral_l1_diminish_num', 1),
      getConfigNumber('referral_l1_diminish_den', 2),
      getConfigNumber('referral_l2l3_lifetime_cap', 2000),
    ]);

    // Confirmed balance + per-level confirmed points (each confirmed amount is already the
    // effective credit). The ledger is the single source of truth.
    const ledger = (await sql`
      select
        coalesce(sum(amount) filter (where status = 'confirmed'), 0)::int              as points_total,
        coalesce(sum(amount) filter (where status = 'confirmed' and level = 1), 0)::int as pts_l1,
        coalesce(sum(amount) filter (where status = 'confirmed' and level = 2), 0)::int as pts_l2,
        coalesce(sum(amount) filter (where status = 'confirmed' and level = 3), 0)::int as pts_l3
      from referral_points_ledger
      where user_id = ${me}::uuid`) as unknown as {
      points_total: number;
      pts_l1: number;
      pts_l2: number;
      pts_l3: number;
    }[];

    // Pending PROJECTED through the same banding the confirm cron applies (same created_at
    // ordering, same ultimate L1 position + L2/L3 lifetime cap), so the number is honest
    // rather than the raw snapshot sum — a farmed tail beyond a wall shows as 0.
    const pending = (await sql`
      with p as (
        select l.level, l.amount,
               row_number() over (partition by (l.level = 1) order by l.created_at, l.id) as rn_grp
        from referral_points_ledger l
        where l.user_id = ${me}::uuid and l.status = 'pending'
      ),
      conf as (
        select count(*) filter (where level = 1)      as l1_conf,
               count(*) filter (where level in (2, 3)) as l23_conf
        from referral_points_ledger
        where user_id = ${me}::uuid and status = 'confirmed'
      )
      select coalesce(sum(
        case
          when p.level = 1       and ((select l1_conf  from conf) + p.rn_grp) > ${l1HardCap}::int   then 0
          when p.level = 1       and ((select l1_conf  from conf) + p.rn_grp) > ${l1FullCount}::int
            then coalesce(floor(p.amount * ${dimNum}::numeric / nullif(${dimDen}::numeric, 0))::int, 0)
          when p.level in (2, 3) and ((select l23_conf from conf) + p.rn_grp) > ${l2l3Cap}::int     then 0
          else p.amount
        end), 0)::int as points_pending
      from p`) as unknown as { points_pending: number }[];

    // Invited counts per tier straight off the denormalized ancestor columns.
    const counts = (await sql`
      select
        (select count(*) from users where referred_by = ${me}::uuid)::int as inv_l1,
        (select count(*) from users where ref_l2      = ${me}::uuid)::int as inv_l2,
        (select count(*) from users where ref_l3      = ${me}::uuid)::int as inv_l3`) as unknown as {
      inv_l1: number;
      inv_l2: number;
      inv_l3: number;
    }[];

    const l = ledger[0] ?? { points_total: 0, pts_l1: 0, pts_l2: 0, pts_l3: 0 };
    const c = counts[0] ?? { inv_l1: 0, inv_l2: 0, inv_l3: 0 };
    const pointsPending = pending[0]?.points_pending ?? 0;

    const code = auth.user.publicId;
    const link = await buildReferralLink(code);

    send(res, 200, {
      code,
      link,
      points_total: l.points_total,
      points_pending: pointsPending,
      levels: [
        { level: 1, invited: c.inv_l1, points: l.pts_l1 },
        { level: 2, invited: c.inv_l2, points: l.pts_l2 },
        { level: 3, invited: c.inv_l3, points: l.pts_l3 },
      ],
    });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
