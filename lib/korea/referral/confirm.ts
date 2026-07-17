// lib/korea/referral/confirm.ts
//
// Confirm cron (POST /api/cron/referral-confirm). Flips eligible `pending` ledger rows
// after the anti-fraud delay. It does NOT write any balance: the confirmed sum of the
// ledger is the single source of truth (reads compute it live), so this cron only changes
// row status. Idempotent and resumable — a missed or duplicated tick is harmless (the
// `status='pending'` guard on the UPDATEs resolves each row at most once).
//
// SINGLE-FLIGHT (anti double-run): Neon HTTP has no cross-statement locks, and two
// overlapping ticks could each spend the daily budget / punch through a cap. We take a
// TOKEN-BASED lease on the `referral_confirm_lock` config row (atomic conditional upsert):
// a tick acquires only if the previous lease is stale, writing a fresh random token; it
// releases with a compare-and-set on THAT token. So if this tick runs longer than the TTL
// and another process legitimately takes over, our release matches nobody and can't clobber
// the new holder's lease. A crashed run's lease simply self-expires after the TTL.
//
// CAPS (all config-tunable, per recipient):
//   * daily cap — a single SHARED budget across ALL levels (L1+L2+L3); the excess drips.
//   * L1: first `referral_l1_full_count` confirmed pay full; up to `referral_l1_hard_cap`
//     pay a diminished rate (num/den); beyond it -> 0 and the row is VOIDED (terminal wall).
//   * L2/L3: a generous lifetime cap `referral_l2l3_lifetime_cap` on confirmed L2+L3 rows
//     (combined); beyond it -> VOIDED. Stops slow farming of large low-tier balances.
//   The band/cap uses each row's ULTIMATE position (already-confirmed count + its rank among
//   the recipient's pending rows of that group), which is deterministic and independent of
//   drip timing, so an honest invitee is never wrongly walled by a slow cron.
//   A voided row keeps its snapshot `amount` but is excluded from the balance (only
//   status='confirmed' counts), so no decrement is ever needed.
//
// Ordering is by (created_at, id) — the invite's real age — NOT eligible_at, so retuning
// the delay can never reorder the queue and push an honest early invite past a wall. A tick
// is bounded on BOTH axes to survive Neon's statement-timeout on a big backlog: at most
// `referral_confirm_batch_recipients` recipients AND ~`referral_confirm_batch_rows` rows
// (oldest-waiting first; each selected recipient's pending set is loaded WHOLE so banding
// stays correct). The rest drips on the next tick.
//
// CLAWBACK: no balance cache means clawback is trivial — flag the users, void their source
// rows (`update ... set status='void' where source_user_id in (flagged) and status='confirmed'`),
// and every balance recomputes itself on the next read. See draft_0004_referral.sql.

import { getSql } from '../core/db.js';
import { getConfigNumber } from '../config.js';

export interface ReferralConfirmResult {
  /** true when the single-flight lease was held by another run and this tick did nothing. */
  skipped: boolean;
  confirmed: number;
  pointsAwarded: number;
  voided: number;
  /** Age (hours) of the OLDEST still-eligible pending row after this run — a cron-stall /
   *  frozen-points signal for monitoring. null when nothing eligible is left pending. */
  oldestEligiblePendingHours: number | null;
}

const IDLE: Omit<ReferralConfirmResult, 'skipped'> = {
  confirmed: 0,
  pointsAwarded: 0,
  voided: 0,
  oldestEligiblePendingHours: null,
};

export async function runReferralConfirm(): Promise<ReferralConfirmResult> {
  const sql = getSql();
  const leaseSeconds = await getConfigNumber('referral_confirm_lock_ttl_seconds', 300);

  // Acquire the single-flight lease: take it iff the stored epoch is older than the TTL,
  // writing a fresh token we alone hold. Self-heals if the config row is missing (first run
  // inserts + acquires). Empty result => a live lease is held elsewhere -> skip this tick.
  const acquired = (await sql`
    insert into config (key, value)
    values ('referral_confirm_lock', jsonb_build_object('token', gen_random_uuid()::text, 'ts', extract(epoch from now())))
    on conflict (key) do update set value = jsonb_build_object('token', gen_random_uuid()::text, 'ts', extract(epoch from now()))
      where coalesce((config.value->>'ts')::double precision, 0) < extract(epoch from now()) - ${leaseSeconds}
    returning value->>'token' as token`) as unknown as { token: string }[];
  const token = acquired[0]?.token;
  if (!token) return { skipped: true, ...IDLE };

  try {
    const [dailyCap, l1FullCount, l1HardCap, dimNum, dimDen, l2l3Cap, batchRecipients, batchRows] =
      await Promise.all([
        getConfigNumber('referral_daily_confirm_cap', 20),
        getConfigNumber('referral_l1_full_count', 20),
        getConfigNumber('referral_l1_hard_cap', 100),
        getConfigNumber('referral_l1_diminish_num', 1),
        getConfigNumber('referral_l1_diminish_den', 2),
        getConfigNumber('referral_l2l3_lifetime_cap', 2000),
        getConfigNumber('referral_confirm_batch_recipients', 1000),
        getConfigNumber('referral_confirm_batch_rows', 5000),
      ]);

    const rows = (await sql`
      with batch as (
        -- oldest-waiting recipients, bounded by BOTH a recipient count and a total row
        -- budget; a recipient is included whole (all their pending rows) so banding is exact.
        select user_id
        from (
          select user_id,
                 min(eligible_at) as oldest,
                 count(*) as cnt,
                 sum(count(*)) over (order by min(eligible_at), user_id) as running_incl
          from referral_points_ledger
          where status = 'pending' and eligible_at is not null and eligible_at < now()
          group by user_id
        ) g
        where g.running_incl - g.cnt < ${batchRows}::int
        order by g.oldest, g.user_id
        limit ${batchRecipients}::int
      ),
      elig as (
        -- rn_grp: rank within the recipient's L1 rows (level=1 group) OR within their
        -- combined L2+L3 rows (level<>1 group) — drives both the L1 wall and the L2/L3 cap.
        select l.id, l.user_id, l.amount, l.level, l.created_at,
               row_number() over (partition by l.user_id, (l.level = 1) order by l.created_at, l.id) as rn_grp
        from referral_points_ledger l
        join batch b on b.user_id = l.user_id
        where l.status = 'pending' and l.eligible_at is not null and l.eligible_at < now()
      ),
      stats as (
        select b.user_id,
               coalesce((select count(*) from referral_points_ledger c
                         where c.user_id = b.user_id and c.status = 'confirmed'
                           and c.confirmed_at > now() - interval '24 hours'), 0) as day_used,
               coalesce((select count(*) from referral_points_ledger c
                         where c.user_id = b.user_id and c.status = 'confirmed' and c.level = 1), 0) as l1_conf,
               coalesce((select count(*) from referral_points_ledger c
                         where c.user_id = b.user_id and c.status = 'confirmed' and c.level in (2, 3)), 0) as l23_conf
        from batch b
      ),
      classified as (
        -- ultimate position per group; classify action + effective credit
        select e.id, e.user_id, e.amount, e.level, e.created_at, s.day_used,
               case
                 when e.level = 1        and (s.l1_conf  + e.rn_grp) > ${l1HardCap}::int then 'void'
                 when e.level in (2, 3)  and (s.l23_conf + e.rn_grp) > ${l2l3Cap}::int   then 'void'
                 else 'confirm'
               end as action,
               case
                 when e.level = 1       and (s.l1_conf  + e.rn_grp) > ${l1HardCap}::int   then 0
                 when e.level = 1       and (s.l1_conf  + e.rn_grp) > ${l1FullCount}::int
                   then coalesce(floor(e.amount * ${dimNum}::numeric / nullif(${dimDen}::numeric, 0))::int, 0)
                 when e.level in (2, 3) and (s.l23_conf + e.rn_grp) > ${l2l3Cap}::int     then 0
                 else e.amount
               end as effective
        from elig e
        join stats s on s.user_id = e.user_id
      ),
      confirmable as (
        -- only would-confirm rows compete for the shared daily budget (voids don't consume it)
        select c.id, c.effective, c.day_used,
               row_number() over (partition by c.user_id order by c.created_at, c.id) as rn_day
        from classified c
        where c.action = 'confirm'
      ),
      to_confirm as (
        select cf.id, cf.effective
        from confirmable cf
        where cf.rn_day <= greatest(0, ${dailyCap}::int - cf.day_used)
      ),
      to_void as (
        select id from classified where action = 'void'
      ),
      upd_conf as (
        update referral_points_ledger l
        set status = 'confirmed', confirmed_at = now(), amount = tc.effective
        from to_confirm tc
        where l.id = tc.id and l.status = 'pending'
        returning l.amount
      ),
      upd_void as (
        update referral_points_ledger l
        set status = 'void', confirmed_at = now()
        from to_void tv
        where l.id = tv.id and l.status = 'pending'
        returning l.id
      )
      select (select count(*) from upd_conf)::int                 as confirmed,
             (select coalesce(sum(amount), 0) from upd_conf)::int  as points_awarded,
             (select count(*) from upd_void)::int                  as voided`) as unknown as {
      confirmed: number;
      points_awarded: number;
      voided: number;
    }[];

    // Separate read (post-commit) so the stall metric reflects what is STILL pending after
    // this run — a data-modifying CTE cannot observe its own writes within one snapshot.
    const age = (await sql`
      select extract(epoch from (now() - min(eligible_at))) / 3600.0 as hours
      from referral_points_ledger
      where status = 'pending' and eligible_at is not null and eligible_at < now()`) as unknown as {
      hours: number | null;
    }[];

    const r = rows[0];
    const oldest = age[0]?.hours;
    return {
      skipped: false,
      confirmed: r?.confirmed ?? 0,
      pointsAwarded: r?.points_awarded ?? 0,
      voided: r?.voided ?? 0,
      oldestEligiblePendingHours: typeof oldest === 'number' ? oldest : null,
    };
  } finally {
    // Release only OUR lease (compare-and-set on the token). If a slow run was superseded
    // after the TTL, this matches nobody and safely no-ops; a crash lets the lease expire.
    try {
      await sql`
        update config set value = jsonb_build_object('token', '', 'ts', 0)
        where key = 'referral_confirm_lock' and value->>'token' = ${token}`;
    } catch {
      /* lease will self-expire via TTL */
    }
  }
}
