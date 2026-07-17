// lib/korea/referral/accrue.ts
//
// Referral accrual — invoked best-effort when an invited user performs the target action
// (first contact reveal). Records ONE activation for the actor and credits up to three of
// their ancestors (L1/L2/L3) with `pending` ledger rows that a later cron confirms.
//
// Neon HTTP has no multi-statement transactions, so atomicity is built from a SINGLE
// statement: two data-modifying CTEs (activation insert -> ledger insert) plus a final
// SELECT that reports the counts. Idempotency is structural:
//   * referral_activations.user_id UNIQUE + `on conflict do nothing` -> at most one
//     activation per invitee ever; a repeat action inserts nothing and credits no one.
//   * the ledger insert reads the activation's RETURNING output, so it fires ONLY when a
//     fresh activation was created (an existing activation => empty `act` => zero credits).
//   * UNIQUE(activation_id, user_id) + `on conflict do nothing` is a belt-and-suspenders
//     guard against crediting the same ancestor twice for one activation.
//
// Rates and the confirm delay are read from config at accrual time and BOUND as the
// snapshot amount (config may change later without rewriting history). Never throws out
// of the caller's control — callers still wrap this in try/catch (best-effort), but the
// enabled flag is honored here so a disabled program is a cheap no-op.

import { getSql } from '../core/db.js';
import { getConfigBool, getConfigNumber } from '../config.js';

export interface AccrualResult {
  /** true when a fresh activation row was created (i.e. the actor's first target action). */
  activated: boolean;
  /** number of pending ledger rows written for the actor's ancestors (0..3). */
  ledgerRows: number;
}

/**
 * Record the actor's activation and credit their up-to-3 ancestors (pending).
 * @param sql   the shared Neon query tag (getSql()).
 * @param actorUserId the invited user who performed the target action (users.id).
 * @param kind  the activation kind (e.g. 'contact_reveal') — stored on the activation.
 */
export async function recordReferralActivation(
  sql: ReturnType<typeof getSql>,
  actorUserId: string,
  kind: string,
): Promise<AccrualResult> {
  // Cached (config.ts, 60s), but read in parallel for cleanliness.
  const [enabled, l1, l2, l3, delayHours] = await Promise.all([
    getConfigBool('referral_enabled', true),
    getConfigNumber('referral_points_l1', 100),
    getConfigNumber('referral_points_l2', 30),
    getConfigNumber('referral_points_l3', 10),
    getConfigNumber('referral_confirm_delay_hours', 48),
  ]);
  if (!enabled) return { activated: false, ledgerRows: 0 };

  const rows = (await sql`
    with act as (
      insert into referral_activations (user_id, kind, status, eligible_at)
      values (${actorUserId}::uuid, ${kind}, 'pending', now() + make_interval(hours => ${delayHours}))
      on conflict (user_id) do nothing
      returning id
    ),
    actor as (
      select referred_by, ref_l2, ref_l3 from users where id = ${actorUserId}::uuid
    ),
    ancestors as (
      -- recipient <> actor guards against a self-credit if a cross-invite cycle inside the
      -- bind window ever put the actor into their own ref_l2/ref_l3 snapshot.
      select referred_by as recipient, 1::smallint as level, ${l1}::int as amount
        from actor where referred_by is not null and referred_by <> ${actorUserId}::uuid
      union all
      select ref_l2, 2::smallint, ${l2}::int from actor
        where ref_l2 is not null and ref_l2 <> ${actorUserId}::uuid
      union all
      select ref_l3, 3::smallint, ${l3}::int from actor
        where ref_l3 is not null and ref_l3 <> ${actorUserId}::uuid
    ),
    led as (
      insert into referral_points_ledger
        (user_id, amount, level, reason, source_user_id, activation_id, status, eligible_at)
      select anc.recipient, anc.amount, anc.level, 'activation', ${actorUserId}::uuid, act.id,
             'pending', now() + make_interval(hours => ${delayHours})
      from act
      cross join ancestors anc
      on conflict (activation_id, user_id) do nothing
      returning id
    )
    select (select count(*) from act)::int as activated,
           (select count(*) from led)::int as ledger_rows`) as unknown as {
    activated: number;
    ledger_rows: number;
  }[];

  const r = rows[0];
  return {
    activated: (r?.activated ?? 0) > 0,
    ledgerRows: r?.ledger_rows ?? 0,
  };
}
