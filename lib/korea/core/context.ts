// lib/korea/core/context.ts
//
// The auth boundary for every user-facing endpoint. Verifies the Telegram initData
// (HMAC over the raw string), lazily upserts the user, and returns the trusted user
// row. The user id used for scoping ALWAYS comes from here — never from the request
// body/query (007: this is the only barrier against cross-user leakage on Neon).
//
// TWO DOORS, ONE ROOM (since 23.09.2026):
//   `Authorization: tma <initData>`  — Telegram Mini App, the original door;
//   `Authorization: kjs <pass>`      — our own session pass, issued at POST /api/auth/hub
//                                      in exchange for an AppHub Studio ticket.
// One header carries one scheme, so a request belongs to exactly one door and the two
// branches never meet. They share the RETURNED shape and nothing else — in particular
// they do NOT share an upsert: see authenticateHubSession below for why.

import { getSql } from './db.js';
import { verifyInitData } from './auth.js';
import { verifyHubSession } from './hub-session.js';
import { type ReqLike, hubSessionToken, tmaInitData } from './http.js';
import { getConfigNumber } from '../config.js';
import { bumpVisitStreakBestEffort } from '../streaks/update.js';
import { seoulDate, normalizeDbDate } from './time.js';
import { normalizeRefCode } from './start-param.js';
import {
  ACQ_SOURCE_APPHUB_SHELL,
  resolveAcqSource,
  noteAcqRejectBestEffort,
} from './acq-source.js';

// Re-exported so existing importers (bot webhook `/start`) keep resolving these from
// core/context.js. The parsing itself lives in the shared, pure start-param module.
export {
  normalizeRefCode,
  normalizeAcqSource,
  parseStartParam,
  type StartParam,
} from './start-param.js';

export interface AuthedUser {
  id: string;
  telegramId: string;
  publicId: string;
  lang: string;
  allowsWriteToPm: boolean;
  isBlocked: boolean;
  /**
   * DOOR 2 ONLY: the id of the AppHub Studio ticket this session was minted from
   * (core/hub-session.ts, invariant 7); null for a Telegram launch, which has no ticket.
   *
   * It is here so that an incident can be READ. Replaying a ticket inside its 60 s is a
   * risk the owner accepted — but "accepted" is not "un-investigable": without this field
   * the line `[auth/hub] ok jti=X` joins to nothing, and two sessions born of ONE ticket
   * look exactly like two honest ones. It carries no new personal data (it is the number
   * of the holder's own ticket) and it is deliberately NOT printed on the hot path — it is
   * available to be printed when something is being investigated, not before.
   */
  hubJti: string | null;
}

export type AuthResult = { ok: true; user: AuthedUser } | { ok: false };

// Referral-code extraction (`normalizeRefCode`) now lives in the shared start-param parser
// (./start-param.js), imported + re-exported above. It still yields a 16-hex public_id or
// null — so the attribution branch below is byte-for-byte unchanged — but additionally
// pulls the inviter code out of a "Поделиться вакансией" combined link (v<vacancy>r<ref>).

/**
 * Verify `Authorization: tma <initData>` (or `kjs <pass>`) and upsert the user.
 * Fail-closed.
 */
export async function authenticate(req: ReqLike): Promise<AuthResult> {
  // Door 2 first, and only because it is the cheaper test: a request either carries a
  // `kjs` pass or it does not, and if it does, the Telegram path below has nothing to
  // work with anyway. Everything past this line is the ORIGINAL Telegram door, untouched.
  const pass = hubSessionToken(req);
  if (pass) return authenticateHubSession(pass);

  const raw = tmaInitData(req);
  if (!raw) return { ok: false };

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) throw new Error('auth: BOT_TOKEN is not set');
  const ttl = Number(process.env.INITDATA_TTL_SECONDS ?? '900') || 900;

  const v = verifyInitData(raw, botToken, ttl);
  if (!v.ok) return { ok: false };
  const idt = v.identity;

  const sql = getSql();
  // Upsert: refresh profile + last_seen; allows_write_to_pm is only ever RAISED
  // (a stale payload that omits it must never lower a granted flag). lang is set on
  // first insert only — the app owns the display language after that.
  //
  // Referral attribution only matters when a code is actually present, so the hot path
  // (no start_param) runs the plain upsert untouched. With a code the branch is structural:
  //   * a fresh INSERT binds the ancestors from the resolved code (VALUES) — first touch;
  //   * the ON CONFLICT (UPDATE) path binds ONLY if the existing row is still EMPTY: no
  //     referrer yet, created inside the bind window, and no activation/contact reveal on
  //     record. That narrow window lets the current base opt into virality without ever
  //     re-attributing / hijacking a mature account.
  // Every condition reads the actual target row (users.*), so the outcome is independent
  // of which path inserted first (the Mini App vs the bot /start) — the attribution race
  // is gone without needing to test xmax.
  //
  // A third, mutually exclusive shape exists since 2026-08-01: an ACQUISITION LABEL
  // (`?startapp=ads_ru1`, the link the owner puts into Telegram Ads). It is written to
  // users.acq_source in the INSERT ONLY — see that branch.
  //
  // The label-less upsert — the hot path, and ALSO the fallback used when the acq_source write
  // below cannot run (see there). Defined once so the two callers can never drift apart.
  const plainUpsert = (): Promise<Record<string, unknown>[]> =>
    sql`
        insert into users (telegram_id, username, first_name, last_name, lang, allows_write_to_pm)
        values (
          ${idt.telegramId}::bigint, ${idt.username ?? null}, ${idt.firstName ?? null},
          ${idt.lastName ?? null}, ${idt.languageCode ?? 'ru'}, ${idt.allowsWriteToPm === true}
        )
        on conflict (telegram_id) do update set
          username = excluded.username,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          last_seen_at = now(),
          allows_write_to_pm = users.allows_write_to_pm or excluded.allows_write_to_pm
        returning id, telegram_id, public_id, lang, allows_write_to_pm, is_blocked, visit_streak_day`;

  // Acquisition label (`?startapp=ads_ru1`, e.g. a Telegram Ads campaign). Disjoint from a
  // referral link by construction, so the two branches below are mutually exclusive — an ad
  // visitor never gets an inviter and never disturbs the referral numbers.
  //
  // The label is ALLOW-LISTED (core/acq-source.ts, shared with the bot `/start` path): only a
  // string the owner approved in config.acq_sources_allowed is stored. `startapp` is public —
  // anybody could otherwise write free text into their own row, and that text survives account
  // erasure. Unknown label -> null + a counter tick; the person is authenticated either way.
  const refCode = normalizeRefCode(idt.startParam ?? null);
  const acq = refCode
    ? { source: null, rejected: false }
    : await resolveAcqSource(idt.startParam ?? null);
  const acqSource = acq.source;
  if (acq.rejected) {
    // Counted, never stored, never logged as a value (third-party input). /stats shows the
    // weekly number so a typo in the ad cabinet becomes visible instead of silent.
    await noteAcqRejectBestEffort(sql);
  }
  const rows = refCode
    ? await (async () => {
        const bindWindowHours = await getConfigNumber('referral_bind_window_hours', 72);
        return sql`
          with ref as (
            select id as ref_id, referred_by as l2, ref_l2 as l3
            from users
            where public_id = ${refCode} and telegram_id <> ${idt.telegramId}::bigint
            limit 1
          )
          insert into users (
            telegram_id, username, first_name, last_name, lang, allows_write_to_pm,
            referred_by, ref_l2, ref_l3
          )
          values (
            ${idt.telegramId}::bigint, ${idt.username ?? null}, ${idt.firstName ?? null},
            ${idt.lastName ?? null}, ${idt.languageCode ?? 'ru'}, ${idt.allowsWriteToPm === true},
            (select ref_id from ref), (select l2 from ref), (select l3 from ref)
          )
          on conflict (telegram_id) do update set
            username = excluded.username,
            first_name = excluded.first_name,
            last_name = excluded.last_name,
            last_seen_at = now(),
            allows_write_to_pm = users.allows_write_to_pm or excluded.allows_write_to_pm,
            referred_by = case when (select ref_id from ref) is not null
                and users.referred_by is null
                and users.created_at > now() - make_interval(hours => ${bindWindowHours})
                and not exists (select 1 from referral_activations a where a.user_id = users.id)
                and not exists (select 1 from contact_reveals cr where cr.user_id = users.id)
                and not exists (select 1 from ad_contact_reveals ar where ar.user_id = users.id)
              then (select ref_id from ref) else users.referred_by end,
            ref_l2 = case when (select ref_id from ref) is not null
                and users.referred_by is null
                and users.created_at > now() - make_interval(hours => ${bindWindowHours})
                and not exists (select 1 from referral_activations a where a.user_id = users.id)
                and not exists (select 1 from contact_reveals cr where cr.user_id = users.id)
                and not exists (select 1 from ad_contact_reveals ar where ar.user_id = users.id)
              then (select l2 from ref) else users.ref_l2 end,
            ref_l3 = case when (select ref_id from ref) is not null
                and users.referred_by is null
                and users.created_at > now() - make_interval(hours => ${bindWindowHours})
                and not exists (select 1 from referral_activations a where a.user_id = users.id)
                and not exists (select 1 from contact_reveals cr where cr.user_id = users.id)
                and not exists (select 1 from ad_contact_reveals ar where ar.user_id = users.id)
              then (select l3 from ref) else users.ref_l3 end
          returning id, telegram_id, public_id, lang, allows_write_to_pm, is_blocked, visit_streak_day`;
      })()
    : acqSource
      ? // Same upsert as the plain one PLUS the label — and the label is in the INSERT only.
        // The ON CONFLICT branch deliberately does NOT mention acq_source: a second visit, a
        // different campaign link or any later link must never rewrite where a person came
        // from, and an account that already existed is not an acquisition at all.
        await (async () => {
          try {
            return await sql`
              insert into users (
                telegram_id, username, first_name, last_name, lang, allows_write_to_pm, acq_source
              )
              values (
                ${idt.telegramId}::bigint, ${idt.username ?? null}, ${idt.firstName ?? null},
                ${idt.lastName ?? null}, ${idt.languageCode ?? 'ru'}, ${idt.allowsWriteToPm === true},
                ${acqSource}
              )
              on conflict (telegram_id) do update set
                username = excluded.username,
                first_name = excluded.first_name,
                last_name = excluded.last_name,
                last_seen_at = now(),
                allows_write_to_pm = users.allows_write_to_pm or excluded.allows_write_to_pm
              returning id, telegram_id, public_id, lang, allows_write_to_pm, is_blocked, visit_streak_day`;
          } catch {
            // Deploy-before-migrate window: users.acq_source may not exist yet. Losing a
            // campaign count is annoying; refusing to let a person INTO the app (paid click!)
            // is not acceptable — fall back to the label-less upsert and log the FACT.
            //
            // 🔴 THE MESSAGE IS THE LEAK, AND IT IS THE SAME LEAK ON THIS DOOR (fix №5 of
            // the third review, 23.09.2026). This line used to print err.message, and a
            // Postgres message QUOTES what it refused — the telegram_id bound a few lines
            // above — straight into the Vercel log, once per launch. The kjs branch below
            // was cleaned of exactly this in the previous round; door 1 kept it. The fact
            // and the place are the whole line; the cause is found by the migration state,
            // not by a quoted value.
            // eslint-disable-next-line no-console
            console.error('[auth] acq_source upsert failed, falling back (column missing?)');
            return plainUpsert();
          }
        })()
      : await plainUpsert();

  const u = rows[0];
  if (!u) return { ok: false };

  // Daily VISIT streak: any authenticated action counts as "opened the app today". The streak
  // advances at most once per Asia/Seoul day, and the upsert above already RETURNed the last
  // credited day — so short-circuit and only pay the extra DB round-trip when today is not yet
  // counted. Pure optimization: the bump statement's own WHERE guard (`visit_streak_day is
  // distinct from $today`) stays the race-safe source of truth, and normalizeDbDate returns null
  // on any ambiguity — so we may over-call (a cheap 0-row no-op) but never wrongly skip a real
  // advance. Best-effort (its own try/catch) — a streak failure must NEVER break auth.
  if (normalizeDbDate(u.visit_streak_day) !== seoulDate()) {
    await bumpVisitStreakBestEffort(sql, u.id as string);
  }

  return {
    ok: true,
    user: {
      id: u.id as string,
      telegramId: String(u.telegram_id),
      publicId: u.public_id as string,
      lang: u.lang as string,
      allowsWriteToPm: u.allows_write_to_pm === true,
      isBlocked: u.is_blocked === true,
      // The Telegram door has no hub ticket — and "not said" stays "not known".
      hubJti: null,
    },
  };
}

/**
 * DOOR 2: `Authorization: kjs <pass>` — a visitor from the AppHub Studio shell, holding the
 * pass minted at POST /api/auth/hub (core/hub-session.ts) out of a hub ticket.
 *
 * 🔴 ITS OWN UPSERT, AND THAT IS THE WHOLE POINT OF THE BRANCH.
 *    A ticket brings ONE identity and NOT ONE profile field — so a login by ticket has no
 *    right to OVERWRITE anything in the profile.
 * The Telegram upsert above refreshes username/first_name/last_name from every launch,
 * because initData really does carry them fresh from Telegram. Reusing it here would write
 * NULLs "on the ticket's authority" over a name the person already has — a silent data loss
 * on the SECOND door that nobody would connect to it. Hence:
 *   * INSERT names telegram_id, lang and acq_source (our own constant, see below);
 *     username/first_name/last_name are not listed at all, so those columns take their own
 *     defaults instead of a NULL signed by nobody;
 *   * allows_write_to_pm is not listed either — the column's default (false) is the honest
 *     "we have not asked yet", not "not allowed" (a ticket cannot carry this flag: it lives
 *     only inside Telegram's signature issued to a BOT — core/hub-ticket.ts, invariant 6).
 *     🔴 That honest default is INVISIBLE to a person unless the screen says so: this
 *     visitor's bot cannot write to them, so notifications and the digest will never
 *     arrive. GET /api/me therefore reports the flag (users/me.ts), and the screen draws
 *     the honest line next to the toggles instead of a switch that does nothing;
 *   * ON CONFLICT touches last_seen_at AND NOTHING ELSE.
 * The RETURNING list is the same as the Telegram door's — both doors hand the caller the
 * same trusted row. That sentence is a GUARD, not a hope: context.test.ts cuts the
 * `returning …` tail out of every users-upsert in this file and compares them letter by
 * letter, so dropping a column from any ONE of them reddens (fix №4, 23.09.2026 — before
 * it, the test helpers cut that tail off before asserting and nothing noticed).
 *
 * ONE THING IS WRITTEN THAT THE TELEGRAM DOOR DOES NOT WRITE: users.acq_source =
 * 'apphub_shell', in the INSERT only. See ACQ_SOURCE_APPHUB_SHELL for why that is not a
 * contradiction of "a ticket proves nothing about the profile" — the ticket proves exactly
 * this one thing, cryptographically, and nothing else.
 */
async function authenticateHubSession(pass: string): Promise<AuthResult> {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) throw new Error('auth: BOT_TOKEN is not set');

  const v = verifyHubSession(pass, botToken);
  if (!v.ok) return { ok: false };

  // The language hint is used ONLY when the row is created (same rule as the Telegram door:
  // after the first insert the app owns the display language).
  const lang = v.claims.lang ?? 'ru';

  const sql = getSql();
  // The label-less twin, used when the acq_source write cannot run (deploy-before-migrate).
  // Defined once so the two can never drift — same rule as the Telegram door's plainUpsert.
  const plainKjsUpsert = (): Promise<Record<string, unknown>[]> =>
    sql`
      insert into users (telegram_id, lang)
      values (${v.claims.sub}::bigint, ${lang})
      on conflict (telegram_id) do update set
        last_seen_at = now()
      returning id, telegram_id, public_id, lang, allows_write_to_pm, is_blocked, visit_streak_day`;

  let rows: Record<string, unknown>[];
  try {
    // acq_source in the INSERT list ONLY — never in ON CONFLICT. A returning visitor keeps
    // whatever brought them here the FIRST time; an account that already existed was not
    // acquired by the shell, and must not start claiming it was.
    rows = await sql`
      insert into users (telegram_id, lang, acq_source)
      values (${v.claims.sub}::bigint, ${lang}, ${ACQ_SOURCE_APPHUB_SHELL})
      on conflict (telegram_id) do update set
        last_seen_at = now()
      returning id, telegram_id, public_id, lang, allows_write_to_pm, is_blocked, visit_streak_day`;
  } catch {
    // 🔴 THE DRIVER'S OWN ERROR MUST NOT TRAVEL ANYWHERE (fix №5, 23.09.2026). This
    // statement used to be un-guarded, so anything Postgres refused travelled up as the
    // CAUSE of a 500 — and api/index.ts prints cause.message + stack, while a Postgres
    // message QUOTES the value it refused. The telegram_id would land in the Vercel log,
    // once per request, exactly where it was never supposed to be.
    //
    // NOTHING OF THE ERROR IS PRINTED OR RE-THROWN HERE, for that reason: the message is
    // the leak. The name of the door and the fact of the fault are the whole line. (What
    // DOES escape when both statements fail is an error of our own writing — see the inner
    // catch: a 500 is the honest answer, it just must not be the driver's 500.)
    try {
      // Most likely cause by far: users.acq_source not migrated yet. Losing one acquisition
      // count is annoying; locking the second door over it is not acceptable.
      rows = await plainKjsUpsert();
      // eslint-disable-next-line no-console
      console.error('[auth] kjs upsert with acq_source failed, fell back (column missing?)');
    } catch {
      // eslint-disable-next-line no-console
      console.error('[auth] kjs upsert failed');
      // 🔴 A BROKEN DATABASE IS NOT A BROKEN PASS (fix №2 of the third review, 23.09.2026).
      // This used to `return { ok: false }`, which the caller answers with 401 — and the
      // shell shows "this entrance no longer works, go back to AppHub Studio and open it
      // again". The person goes back, the shell mints a brand-new ticket, the exchange
      // SUCCEEDS (POST /api/auth/hub never touches the database) — and the very next
      // request is 401 again. A loop in which the fault is assigned to the person, over a
      // blink of the database, which in this project is not a hypothesis but an outage we
      // have had. Door 1 in the same situation falls honestly into 500.
      //
      // The thrown text is OURS, word for word: there is no PII in it and nothing of the
      // driver's message travels with it. api/index.ts turns it into a 500 under its own
      // errorId (and logs that message + our stack, which is the diagnostic), the shell
      // reads 5xx as "the service is temporarily down", and the person sees the ordinary
      // error strip instead of a door blaming them.
      throw new Error('kjs upsert failed');
    }
  }

  const u = rows[0];
  if (!u) return { ok: false };

  // Same daily VISIT streak as the Telegram door — opening the app through the shell is
  // still opening the app. Best-effort there, best-effort here.
  if (normalizeDbDate(u.visit_streak_day) !== seoulDate()) {
    await bumpVisitStreakBestEffort(sql, u.id as string);
  }

  return {
    ok: true,
    user: {
      id: u.id as string,
      telegramId: String(u.telegram_id),
      publicId: u.public_id as string,
      lang: u.lang as string,
      allowsWriteToPm: u.allows_write_to_pm === true,
      isBlocked: u.is_blocked === true,
      // Carried out to the boundary so an investigation can name the ticket (invariant 7).
      hubJti: v.claims.jti,
    },
  };
}
