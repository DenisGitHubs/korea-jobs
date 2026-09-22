// lib/korea/core/hub-session.ts
//
// OUR OWN PASS — the thing a hub ticket is traded for at POST /api/auth/hub, and the
// only credential the AppHub Studio shell then carries on every request
// (`Authorization: kjs <pass>`).
//
// WHY A PASS AT ALL. A hub ticket lives 60 seconds; korea-jobs sends its identity with
// EVERY request and has no session of its own. Those two do not fit: a ticket cannot be
// the request credential, and a ticket cannot be re-minted without the shell. So the
// ticket is exchanged ONCE for a pass of ours, and the pass is what travels afterwards.
//
// 🔴 HOW LONG A PASS LIVES, NEXT TO WHAT IT COSTS (owner's decision, 22.09.2026 — the
// number is his; this paragraph only writes the comparison down so it can be re-decided
// with the price in view):
//   * DOOR 1, Telegram initData: 900 s (INITDATA_TTL_SECONDS), and it is re-checked from
//     scratch on EVERY request — the Mini App re-supplies a fresh initData on each launch,
//     so a stolen one is worth a quarter of an hour at most.
//   * DOOR 2, this pass: 86400 s. That is 96 TIMES longer. A copied pass is a day of
//     somebody else's account, and nothing in a request tells us it was copied.
//   * REVOCATION. Before 23.09.2026 the only way to kill outstanding passes was to change
//     BOT_TOKEN (invariant 3) — i.e. to burn the bot along with them. Now there is a second
//     lever that touches nothing else: LOWERING HUB_SESSION_TTL_SECONDS kills every pass
//     whose OWN lifetime exceeds the new setting (invariant 8b). Set it to 60 and every
//     day-long pass issued before is dead, while the bot, the Telegram door and every
//     Telegram session keep working.
//     🔴 HOW TO PULL IT, HONESTLY (corrected 23.09.2026 — this paragraph used to promise
//     that lowering the variable took effect on the very next request with nothing else to
//     do, and on Vercel that is simply untrue): set the variable in the project settings
//     AND PRESS REDEPLOY (~1 minute). Vercel bakes environment
//     values into a PARTICULAR deployment — the running one keeps the values it was built
//     with, and the panel itself says the change "will apply on your next deployment". The
//     code really does read process.env on every verify (invariant 8b), which is what makes
//     the lever work from the first request AFTER the redeploy, with no code change and no
//     new bot token. The operating instruction lives where the owner actually looks for it:
//     .env.example, next to the variable.
// The day is therefore a CHOICE with an off switch, not a one-way door. If the owner wants
// a shorter default, one env var plus a redeploy is the whole change: the code reads the
// variable, never the number.
//
// Narrow surface: mintHubSession / verifyHubSession, both pure — no I/O, no env reads
// except the TTL helper, and verify never throws. The one exception to "no output" is that
// helper: an env value that is SET and unusable prints one line naming the variable (never
// its value, never the pass) — see hubSessionTtlSeconds.
//
// INVARIANTS
//   1. FORMAT IS VERSIONED FROM BYTE ONE: `1.<base64url(JSON)>.<base64url(HMAC-SHA256)>`.
//      The leading `1.` is INSIDE the signed string, so a future version 2 cannot be
//      re-read as a version 1 pass by an old server.
//   2. THE SIGNATURE COVERS EXACTLY `1.<body>` — the version marker included. Signing the
//      body alone would let the prefix be rewritten free of charge.
//   3. THE KEY IS DERIVED FROM THE BOT TOKEN: HMAC_SHA256(key='korea-jobs/hub-session/v1',
//      msg=BOT_TOKEN). No new secret to configure, nothing extra to leak — and when the bot
//      is replaced, every pass dies with it, which is the behaviour we want and not a bug.
//      The derivation string is also a DOMAIN SEPARATOR: the same bot token signs Telegram
//      initData under a different label, and no value from one world can be replayed in the
//      other.
//   4. COMPARISON IS timingSafeEqual ONLY (over raw bytes), never `===`.
//      🔴 AND THE SEGMENTS MUST BE CANONICAL BASE64URL FIRST. Node's base64url decoder
//      SILENTLY DROPS characters outside the alphabet: `<sig>` and `<sig>!!!!` decode to
//      the very same 32 bytes, the lengths match, timingSafeEqual is happy, and the request
//      is authorised. No privilege is gained by that — but ANY future revocation list,
//      de-duplication or incident correlation done BY THE TOKEN STRING is bypassed by
//      appending junk, because one pass then has unboundedly many spellings. So the shape
//      of each segment is checked against the base64url alphabet (the signature at EXACTLY
//      43 characters = 32 bytes unpadded) BEFORE anything is decoded.
//   5. `sub` IS AND STAYS A STRING OF DIGITS THAT FITS users.telegram_id (`bigint`) —
//      core/telegram-id.ts owns that rule for both doors. An id past 2^53 must survive the
//      round trip byte for byte; an id past the COLUMN must never get a pass at all, or
//      `${sub}::bigint` fails on every later request and Postgres quotes the id into our
//      own log while doing so (the whole path is written out in core/telegram-id.ts).
//   6. A PASS CARRIES NO PROFILE. Only sub, lang, jti, iat, exp — no name, no username, no
//      write-access flag. What is not in the ticket cannot appear in the pass, and what is
//      not in the pass can never overwrite a profile (core/context.ts, the kjs branch).
//   7. THE PASS CARRIES THE TICKET'S `jti`, AND IT IS REQUIRED. Replaying a ticket inside
//      its 60 s is an ACCEPTED risk (core/hub-ticket.ts, invariant 10) — but "accepted" is
//      not "un-investigable". Without this field the line `[auth/hub] ok jti=X` joins to
//      nothing: two passes minted from ONE ticket are indistinguishable from each other and
//      from an honest one, so an incident cannot even be scoped. With it, every later
//      request can be tied back to the exact ticket that opened the session (core/context.ts
//      carries it out to AuthedUser.hubJti). No new personal data appears: it is the id of
//      the holder's OWN ticket, minted by the hub, and it is the one part of a ticket that
//      is already allowed into a log.
//   8. EXPIRY IS CHECKED HERE, IN VERIFY, not at the call site — and TWICE, because they
//      are two different questions:
//        (a) `exp <= now`      — the pass has run out. Its own clock.
//        (b) `exp - iat > TTL` — the pass was minted under a LONGER lifetime than the one
//            configured right now. `exp` is baked in at mint time, so without (b) lowering
//            HUB_SESSION_TTL_SECONDS would only ever affect passes not yet issued, and the
//            variable would be no lever at all during an incident — the choice would be
//            "burn the bot or tolerate the thief for a day". With (b) it is the revocation
//            switch described at the top of this file (and pulling it means setting the
//            variable AND redeploying — see there). Same rule and same shape as the
//            ticket's `exp - iat > 60` (core/hub-ticket.ts, invariant 4).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { isTelegramIdString } from './telegram-id.js';

/** Version marker — the first segment, and part of what is signed (invariants 1, 2). */
const PASS_VERSION = '1';

/** Domain separator for the key derivation (invariant 3). Changing it invalidates every pass. */
const KEY_LABEL = 'korea-jobs/hub-session/v1';

/** Default pass lifetime: a day (owner's choice, 22.09.2026 — see the header comparison). */
export const HUB_SESSION_DEFAULT_TTL_SEC = 86400;

/** Floor and ceiling for the configured TTL: a minute to a week. */
export const HUB_SESSION_MIN_TTL_SEC = 60;
export const HUB_SESSION_MAX_TTL_SEC = 604800;

/** Name of the tunable. Read through hubSessionTtlSeconds(), never inline. */
export const HUB_SESSION_TTL_ENV = 'HUB_SESSION_TTL_SECONDS';

/**
 * Ticket id carried by a pass (invariant 7). The shape is the HUB's — base64url of 16–64
 * random bytes — and it is restated here rather than imported from core/hub-ticket.ts on
 * purpose: that module pulls in `jose`, and core/context.ts (this module's caller on EVERY
 * authenticated request) has no other reason to load it. hub-session.test.ts pins the two
 * patterns to be IDENTICAL, so the duplication cannot drift.
 */
export const HUB_SESSION_JTI_RE = /^[A-Za-z0-9_-]{22,86}$/;

/** Canonical base64url, non-empty (invariant 4). No padding, no alien characters. */
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The signature segment: EXACTLY 43 base64url characters — HMAC-SHA256 is 32 bytes, and
 * 32 bytes encode to 43 characters without padding. A FIXED length is what makes appended
 * junk impossible rather than merely unhelpful (invariant 4).
 */
const SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;

/** Upper bound on a pass string. A real one is ~200 bytes; a longer one is not ours. */
export const HUB_SESSION_MAX_CHARS = 1024;

export type HubSessionReason =
  /** Not three segments, non-canonical base64url, wrong version marker, unreadable body,
   *  or missing/ill-shaped claims. */
  | 'bad_form'
  /** Signature does not match — forged, truncated or signed with another bot's token. */
  | 'bad_signature'
  /** Past its own `exp` (invariant 8a). */
  | 'expired'
  /** Minted under a longer TTL than the one configured now — REVOKED (invariant 8b). */
  | 'ttl_too_long'
  | 'bad_sub'
  /** Missing or malformed ticket id (invariant 7). */
  | 'bad_jti';

export interface HubSessionClaims {
  /** telegram_id as an exact decimal string. */
  sub: string;
  /** Language tag from the ticket snapshot, or null when the ticket carried none. */
  lang: string | null;
  /** The hub ticket this session was minted from (invariant 7). */
  jti: string;
  iat: number;
  exp: number;
}

export type HubSessionResult =
  | { ok: true; claims: HubSessionClaims }
  | { ok: false; reason: HubSessionReason };

/**
 * Configured pass lifetime. TWO different answers, on purpose (fix №1 of the third review,
 * 23.09.2026):
 *
 *   * THE VARIABLE IS ABSENT (unset, or empty) — not a mistake at all. That is the owner's
 *     default day, and it stays silent, exactly as before.
 *   * THE VARIABLE IS SET AND UNUSABLE (<= 0, not a number, or outside 60 s … 7 days) — a
 *     REFUSAL: the FLOOR (HUB_SESSION_MIN_TTL_SEC) plus ONE loud line naming the variable.
 *
 * 🔴 WHY NOT "fall back to the default" FOR BOTH, the way this function used to work. The
 * old comment promised that a typo must not hand out an immortal pass — true, and it
 * guarded the wrong direction. The dangerous mistake here is not infinity, it is the QUIET
 * SLIDE BACK TO A DAY: `0` is precisely what a person types into this box when he means
 * "kill everything now", and what he got back was the LONGEST life a pass can legally
 * have, with not one line anywhere to say the value had been thrown away. A revocation
 * switch that fails towards permission is not a switch. An unusable setting therefore
 * lands on the shortest lifetime we are willing to issue, and says so out loud.
 *
 * OUT OF RANGE IS REFUSED, NOT CLAMPED, for the same reason: 604801 silently read as a
 * week is a number nobody chose, and silence is exactly how the previous fault worked.
 * Both ends are one class of event — "this value is not one I can use" — so both get the
 * floor and the line.
 *
 * THE VALUE IS NEVER PRINTED, only the NAME: configuration is not ours to echo into a log
 * that more people read than the panel, and the name is the whole of what a person needs
 * in order to go and fix it.
 *
 * NO DE-DUPLICATION of that line. This is read on EVERY verify, so a misconfiguration
 * costs one line per request — that flood is what gets it noticed and fixed within
 * minutes, while a once-per-process cache would leave the hottest instance the only one
 * that ever warned, and no test could tell the difference.
 */
export function hubSessionTtlSeconds(): number {
  const raw = process.env[HUB_SESSION_TTL_ENV];
  // ABSENT is not a fault: the owner's default day, silently.
  if (raw === undefined || raw.trim() === '') return HUB_SESSION_DEFAULT_TTL_SEC;

  const n = Number(raw);
  const whole = Number.isFinite(n) ? Math.floor(n) : NaN;
  if (
    !Number.isFinite(whole) ||
    whole < HUB_SESSION_MIN_TTL_SEC ||
    whole > HUB_SESSION_MAX_TTL_SEC
  ) {
    // SET AND UNUSABLE: the floor, and one line carrying the NAME of the variable — never
    // its value. Loud, because the silent version of this branch is the bug being fixed.
    // eslint-disable-next-line no-console
    console.error(
      `[auth] ${HUB_SESSION_TTL_ENV} is set to an unusable value: refusing it and using ` +
        `${HUB_SESSION_MIN_TTL_SEC}s (the floor). Allowed: a whole number of seconds ` +
        `${HUB_SESSION_MIN_TTL_SEC}..${HUB_SESSION_MAX_TTL_SEC}; unset it for the default.`,
    );
    return HUB_SESSION_MIN_TTL_SEC;
  }
  return whole;
}

/** The signing key for this bot token (invariant 3). Derived per call — it costs microseconds. */
function sessionKey(botToken: string): Buffer {
  return createHmac('sha256', KEY_LABEL).update(botToken).digest();
}

/** base64url of a JSON value, with no padding. */
function encodeBody(claims: HubSessionClaims): string {
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
}

/** The signature over `1.<body>` (invariant 2), raw bytes. */
function signSigned(signed: string, botToken: string): Buffer {
  return createHmac('sha256', sessionKey(botToken)).update(signed).digest();
}

/**
 * Mint a pass for a verified identity.
 *
 * @param telegramId exact decimal string that fits a bigint (never a number — invariant 5)
 * @param lang       language tag from the ticket snapshot, or null when it had none
 * @param jti        the hub ticket's own id — REQUIRED (invariant 7)
 * @param botToken   BOT_TOKEN; the pass key is derived from it
 * @param ttlSec     lifetime; defaults to the configured one
 */
export function mintHubSession(
  telegramId: string,
  lang: string | null,
  jti: string,
  botToken: string,
  ttlSec: number = hubSessionTtlSeconds(),
): { token: string; expiresAt: number } {
  if (!botToken) {
    // Programming error, not a request outcome: minting without a key would produce a pass
    // nobody can verify, and it must be loud where it happens.
    throw new Error('mintHubSession: botToken is required');
  }
  if (!isTelegramIdString(telegramId)) {
    throw new Error('mintHubSession: telegramId must be a decimal string within bigint');
  }
  if (typeof jti !== 'string' || !HUB_SESSION_JTI_RE.test(jti)) {
    throw new Error('mintHubSession: jti must be the ticket id');
  }
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSec;
  const signed = `${PASS_VERSION}.${encodeBody({ sub: telegramId, lang, jti, iat, exp })}`;
  const token = `${signed}.${signSigned(signed, botToken).toString('base64url')}`;
  // 🔴 WE DO NOT ISSUE WHAT WE WOULD NOT ACCEPT. verifyHubSession refuses anything past
  // HUB_SESSION_MAX_CHARS, and while that cap lived on the VERIFY side only, an over-long
  // language tag inside a legitimately signed ticket produced a cheerful 200 with a token
  // that was then refused on EVERY request — a door that opens onto a wall, and a fault
  // that reads as the person's. Loud here, where it is ours.
  if (token.length > HUB_SESSION_MAX_CHARS) {
    throw new Error(
      `mintHubSession: token would be ${token.length} chars, over HUB_SESSION_MAX_CHARS`,
    );
  }
  return { token, expiresAt: exp };
}

/**
 * Verify a pass. Pure, never throws (except on an empty botToken, a programming error),
 * never logs the pass. Expiry AND the TTL lever are part of the verdict (invariant 8).
 */
export function verifyHubSession(
  token: string,
  botToken: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): HubSessionResult {
  if (!botToken) {
    throw new Error('verifyHubSession: botToken is required');
  }
  if (typeof token !== 'string' || token.length === 0 || token.length > HUB_SESSION_MAX_CHARS) {
    return { ok: false, reason: 'bad_form' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'bad_form' };
  const [version, body, signature] = parts as [string, string, string];
  if (version !== PASS_VERSION) return { ok: false, reason: 'bad_form' };
  // Canonical base64url BEFORE any decoding (invariant 4) — this is what makes the pass
  // STRING a stable identifier instead of one of many spellings of the same bytes.
  if (!B64URL_RE.test(body) || !SIGNATURE_RE.test(signature)) {
    return { ok: false, reason: 'bad_form' };
  }

  // Signature FIRST: nothing inside the body is worth reading until we know we wrote it.
  const expected = signSigned(`${version}.${body}`, botToken);
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64url');
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_form' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'bad_form' };
  }
  const claims = parsed as Record<string, unknown>;

  const sub = claims['sub'];
  if (!isTelegramIdString(sub)) {
    return { ok: false, reason: 'bad_sub' };
  }
  const jti = claims['jti'];
  if (typeof jti !== 'string' || !HUB_SESSION_JTI_RE.test(jti)) {
    return { ok: false, reason: 'bad_jti' };
  }
  const iat = claims['iat'];
  const exp = claims['exp'];
  if (
    typeof iat !== 'number' ||
    !Number.isFinite(iat) ||
    typeof exp !== 'number' ||
    !Number.isFinite(exp)
  ) {
    return { ok: false, reason: 'bad_form' };
  }
  const langRaw = claims['lang'];
  if (langRaw !== null && typeof langRaw !== 'string') {
    return { ok: false, reason: 'bad_form' };
  }
  if (exp <= nowSec) {
    return { ok: false, reason: 'expired' };
  }
  // The revocation lever (invariant 8b). Read on EVERY verify, so the setting in force is
  // the one the running deployment was built with — change it in the panel AND redeploy,
  // and from the first request after that every over-long pass is refused. No code change,
  // no new bot token, nothing else touched (the honest wording lives in the header).
  if (exp - iat > hubSessionTtlSeconds()) {
    return { ok: false, reason: 'ttl_too_long' };
  }

  return { ok: true, claims: { sub, lang: langRaw, jti, iat, exp } };
}
