// lib/korea/core/hub-ticket.ts
//
// THE SECOND DOOR IN: a ticket signed by the AppHub Studio shell's hub
// (`apphub-hub`), so a person who already signed into Telegram INSIDE the AppHub
// Studio app arrives here already identified.
//
// Narrow surface: verifyHubTicket(ticket) -> HubTicketResult (discriminated union,
// never throws). Call sites only branch on `ok`.
//
// korea-jobs only VERIFIES tickets. It never issues one and holds no private key:
// what changes versus the Telegram door is not WHO we trust, but WHAT proves it —
// initData is signed with our bot token, a ticket with the hub's private key, which
// we neither have nor want.
//
// INVARIANTS
//   1. ALGORITHM IS PINNED: EdDSA (Ed25519) and nothing else — never `none`, never
//      HS*. There are TWO guards and both must stay:
//        (a) our own header parse, BEFORE any cryptography (step 3 below);
//        (b) `algorithms: ['EdDSA']` inside jose itself.
//      Their reason codes are DIFFERENT on purpose — 'bad_alg' and 'bad_alg_late'.
//      While one code served both, deleting guard (a) reddened NO test at all: the
//      substitution was caught by the library and our own guard existed only in this
//      header (skill comment-invariant-needs-companion-test.md). 'bad_alg_late' in the
//      log means guard (a) missed something — read step 3 here first.
//   2. PUBLIC KEY ONLY, AND NOT ONE CALL TO THE HUB. The private key lives on the hub;
//      there is no shared secret across the apps, or the owner of any one of them could
//      mint tickets for the others. Enforced, not merely stated: a PRIVATE key pasted into
//      HUB_TICKET_PUBLIC_KEY is REFUSED as unconfigured — Node would otherwise derive the
//      public half from it and everything would work, with the hub's private key sitting
//      in our environment and nothing ever saying so (see toPublicKeyPem).
//   3. `aud` IS CHECKED AGAINST OUR OWN NAME — HUB_TICKET_AUDIENCE, the single place in
//      this project that spells it (skill single-source-of-truth-logic.md). A ticket
//      minted for another app does not open this door. An ARRAY `aud` is refused: this
//      door belongs to one application.
//   4. LIFETIME 60 s, CLOCK SKEW <= 5 s. A ticket with a longer life is refused EVEN IF
//      signed by the real key: "signed by the hub" does not mean "lives an hour".
//   5. THE TICKET NEVER REACHES A LOG, WHOLE OR IN PART — like initData. Outward and
//      into our log goes the MACHINE REASON and nothing else; a SUCCESSFUL login logs
//      its `jti` only, so a thief's login and the owner's are distinguishable at all.
//   6. THE SNAPSHOT IS A HINT, NOT A RECORD. The whitelist is exactly ['language'] (the
//      hub's handoff sends `snapshot = { language: profile.language_code }` — inside the
//      ticket the field is named `language`). An unknown field is a REFUSAL, not a "let
//      it pass": the snapshot is signed, so its composition is part of the contract.
//      A ticket carries no `allows_write_to_pm` and no `start_param`, and that is not a
//      "no" — those exist only inside Telegram's own signature issued to a BOT, and the
//      hub holds no bot tokens. "Not said" must stay "not known" (see core/context.ts).
//   7. `sub` IS READ AS A STRING, WITH NO 2^53 CEILING — a DELIBERATE difference from
//      the ParaTravel copy of this door, which refuses such a ticket. Their column is
//      read as a JavaScript number; ours (users.telegram_id) is a bigint carried as an
//      exact decimal string end to end (core/auth.ts does the same for initData). A
//      19-digit id MUST get in here.
//      🔴 AND NO BIGGER THAN THE COLUMN (fix №5 of the review, 23.09.2026). "No 2^53
//      ceiling" was read as "no ceiling", and a 20–25 digit sub passed everything here and
//      then failed `${sub}::bigint` on EVERY later request — where Postgres quotes the
//      rejected value into the error, api/index.ts prints cause.message + stack, and the
//      telegram_id we kept out of the log all the way lands in it. The one rule for both
//      doors lives in core/telegram-id.ts.
//   8. NO USABLE KEY -> 'not_configured', which the door answers with 503, NOT 401: the
//      server is unconfigured, not the ticket forged, and mixing those two sends a person
//      to reinstall an app over our own typo. The REASON goes to the door and the DOOR
//      prints one line naming the variable (never its value); THIS MODULE PRINTS NOTHING
//      AT ALL, so one refusal stays one log line (fix №11, 23.09.2026).
//      🔴 The key TYPE is checked by us, with node:crypto — NOT left to the library.
//      Measured on jose 5.10 + Node 20: `importSPKI(pem, 'EdDSA')` accepts an RSA or a
//      P-256 key without a murmur, and the wrong key type would then surface much later
//      as "bad signature" (401) on every single login.
//      🔴 AND THE VARIABLE IS A LIST, NOT A SLOT (fix №8, 23.09.2026). The hub is a project
//      under active work; re-issuing its key pair is its normal answer to a leak. With one
//      slot, the moment the hub rotates EVERY genuine ticket answers 'bad_signature' -> 401
//      — indistinguishable from an attack, i.e. the system lies towards "you are being
//      attacked" at exactly the moment the 401/503 distinction would finally have paid off.
//      So HUB_TICKET_PUBLIC_KEY holds one or more keys (separated by a comma, a semicolon,
//      a blank line — or simply written one under the other, END then BEGIN, which is what
//      a hand does in the panel; fix №3, 23.09.2026, see splitKeyList); they are tried in
//      order and only "not one of them fits" is a refusal; 'not_configured' means NO usable
//      Ed25519 key in the list at all — which is also what isHubTicketConfigured() reports
//      since fix №6. Rotation
//      becomes two edits of an env var with no downtime: add the new key beside the old,
//      then remove the old.
//   9. THIS FUNCTION NEVER THROWS. The door needs a machine reason, not an exception on
//      the hot path: 'not_configured' is an ANSWER, not a crash.
//  10. 🔴 ACCEPTED RISK — THE TICKET IS A BEARER TOKEN, AND WE KEEP NO `jti` STORE.
//      Within its 60 seconds the SAME ticket may be presented any number of times, and
//      each presentation mints a FRESH pass that lives a full day. So the 60 seconds
//      protect the TICKET, not its CONSEQUENCE: whoever copies a ticket once inside that
//      window gets a day of access, and nothing here notices the second use. Closing it
//      needs a persistent store of spent `jti` (an in-process one is worth nothing on
//      serverless — skill serverless-inmemory-rate-limit-void.md), which means a
//      migration, and that awaits the owner's decision. This is the same risk the hub
//      itself accepted (it does not require a ticket to be single-use). Documented — not
//      fixed — and pinned by a test named after the risk, in hub-ticket.test.ts.

import { createPublicKey, type KeyObject } from 'node:crypto';
import { jwtVerify } from 'jose';
import { isTelegramIdString } from './telegram-id.js';

/** The only algorithm we accept. Changing it means re-issuing the hub's key pair. */
export const HUB_TICKET_ALG = 'EdDSA';

/** Who signs. Checked as strictly as the audience (invariant 3). */
export const HUB_TICKET_ISSUER = 'apphub-hub';

/**
 * Our own name inside the ticket — the app key the hub registered us under
 * (hub apps registry: 'korea_jobs'). THE ONLY place this project spells it: every
 * other file imports this constant (invariant 3).
 */
export const HUB_TICKET_AUDIENCE = 'korea_jobs';

/** Ticket lifetime agreed with the hub. Longer than this is refused (invariant 4). */
export const HUB_TICKET_TTL_SEC = 60;

/** Clock difference tolerated between a phone, Vercel and the hub. */
export const HUB_TICKET_MAX_SKEW_SEC = 5;

/**
 * Upper bound on the ticket string. A real one is a few hundred bytes; the cap refuses
 * an oversized body before it reaches any parser.
 */
export const HUB_TICKET_MAX_CHARS = 4096;

/** The NAME of the variable holding the public key(s). Its value never appears anywhere. */
export const HUB_TICKET_PUBLIC_KEY_ENV = 'HUB_TICKET_PUBLIC_KEY';

/**
 * Ticket id as the hub mints it: base64url of 16–64 random bytes. Exported because the
 * PASS carries it too (core/hub-session.ts, invariant 7) and the two shapes must agree;
 * hub-session.ts restates the pattern instead of importing it (to keep `jose` off the
 * per-request path) and hub-session.test.ts pins the two to be identical.
 */
export const HUB_TICKET_JTI_RE = /^[A-Za-z0-9_-]{22,86}$/;

/** The whole of the snapshot whitelist (invariant 6). */
const SNAPSHOT_FIELDS: readonly string[] = Object.freeze(['language']);

/**
 * Longest language tag we accept in a snapshot. RFC 5646 puts every tag a person actually
 * uses far under this; 35 is the practical bound quoted for a well-formed tag.
 *
 * 🔴 THE BOUND LIVES WHERE THE VALUE IS BORN (fix №7 of the review, 23.09.2026). Without
 * it the only limit on the tag was the 4096-char cap on the WHOLE ticket (the pattern
 * below ends in an unbounded repeat), so a ticket the hub really signed, carrying a ~700
 * character tag, was accepted here, answered 200 at the door — and produced a pass past
 * HUB_SESSION_MAX_CHARS, refused on every subsequent request. We must not issue what we
 * would not accept, and the cheapest place to say so is here.
 */
export const HUB_TICKET_MAX_LANGUAGE_CHARS = 35;

/**
 * Language tag as the HUB may send it — wider than ours on purpose (it serves several
 * applications). What we then DO with a tag our own column refuses is decided at the
 * call site, not here: this file only says "the ticket is well formed". The LENGTH is
 * checked before this pattern ever runs (see HUB_TICKET_MAX_LANGUAGE_CHARS).
 */
const SNAPSHOT_LANGUAGE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

/**
 * Canonical base64url for a JWS segment. Node (and jose) SILENTLY DROP characters outside
 * the alphabet when decoding, so `<seg>` and `<seg>!!!!` are the same bytes to them — the
 * same disease the pass had (core/hub-session.ts, invariant 4). Checked here, before any
 * decoding, so one ticket has exactly one spelling.
 */
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * MACHINE REASONS. They travel into OUR server log and nowhere else: the caller always
 * gets one and the same refusal, so a probe cannot learn which check it tripped.
 *
 * The names are the hub's names on purpose — one word means the same thing on both sides
 * of the door, and an incident is read by comparing two logs, not by translating between
 * two vocabularies.
 */
export type HubTicketReason =
  /** HUB_TICKET_PUBLIC_KEY unset or unusable. NOT an attack — 503, not 401 (invariant 8). */
  | 'not_configured'
  | 'bad_form'
  /** Refused by OUR header check, before any cryptography (invariant 1, guard (a)). */
  | 'bad_alg'
  /** Refused by jose itself (invariant 1, guard (b)). Its appearance means guard (a) missed. */
  | 'bad_alg_late'
  | 'bad_signature'
  | 'expired'
  | 'issued_in_future'
  | 'ttl_too_long'
  | 'iss_mismatch'
  | 'aud_mismatch'
  | 'bad_sub'
  | 'bad_jti'
  | 'bad_snapshot';

/** A verified ticket. `telegramId` comes back EXACTLY as it was signed (invariant 7). */
export interface HubTicketIdentity {
  telegramId: string;
  /** The audience the ticket was minted for — always HUB_TICKET_AUDIENCE once verified. */
  app: string;
  /** Ticket id. The ONLY part of a ticket ever allowed into a log (invariant 5). */
  jti: string;
  issuedAt: number;
  expiresAt: number;
  /** From the snapshot whitelist; null when the ticket carried no snapshot at all. */
  language: string | null;
}

export type HubTicketResult =
  | { ok: true; identity: HubTicketIdentity }
  | { ok: false; reason: HubTicketReason };

/**
 * True when this door is CONFIGURED — i.e. the variable holds at least one usable Ed25519
 * public key, which is exactly the question 'not_configured' answers (invariant 8).
 *
 * 🔴 IT USED TO ANSWER A DIFFERENT QUESTION (fix №6 of the third review, 23.09.2026): "the
 * string is non-empty". Same name, same `true`, and a list holding one line of junk got a
 * confident "configured" while the door answered 503 to every real ticket. Harmless only
 * while the sole caller was a test — the first caller from real code would have been told
 * the opposite of the truth. The body now asks readPublicKeys(), so the word "configured"
 * means here what it means at the door (skill field-name-not-documentation.md).
 *
 * Still never the VALUE — only the verdict.
 */
export function isHubTicketConfigured(): boolean {
  return readPublicKeys().length > 0;
}

/**
 * Split the configured value into CANDIDATE keys (invariant 8, the list).
 *
 * Separators: a comma, a semicolon, a blank line — none of which can occur INSIDE a PEM
 * (its body is base64, i.e. [A-Za-z0-9+/=], and its lines are never blank) or inside
 * base64 of a whole PEM file — and, since the third review, THE PEM BOUNDARY ITSELF.
 *
 * 🔴 WHY THE BOUNDARY HAD TO BE ADDED (fix №3 of the third review, 23.09.2026). The most
 * natural way to write two keys is the one a hand actually uses in the Vercel panel:
 * …END PUBLIC KEY-----, Enter, -----BEGIN PUBLIC KEY…, i.e. ONE newline and no blank line.
 * Without this branch that is a single chunk: createPublicKey() reads only the first block
 * (or throws, and then EVERY key falls out as 'not_configured'). Either way the NEW key is
 * invisible at precisely the moment of the rotation, and the log fills with 'bad_signature'
 * for every GENUINE ticket — the 401 storm this list exists to prevent.
 *
 * The existing test did not catch it because a PEM produced by export() already ends in a
 * newline, so gluing two of them with '\n' makes a blank line by itself. The guard now
 * trims the first PEM, so the boundary is the ONLY thing separating them.
 *
 * Both newline forms are spelled, here and in the blank-line branch, because a one-line
 * .env value writes its newlines as the two characters \n.
 */
function splitKeyList(raw: string): string[] {
  return raw
    .split(/[,;]|\r?\n\s*\r?\n|\\n\s*\\n|(?<=-----END [A-Z ]*KEY-----)(?:\s|\\n)*(?=-----BEGIN)/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

/**
 * Bring ONE configured chunk to a real PEM.
 *
 * WHY: a PEM is multi-line, and environments survive newlines differently — Vercel keeps
 * them, a .env file usually holds the key on one line with a two-character \n, and by hand
 * the key is often pasted as base64 of the whole file. Without this, any one of the three
 * forms looks like "the key is broken" and sends you hunting a signature fault that is not
 * there.
 *
 * @returns PEM text, or null when the chunk is not one.
 */
function toPublicKeyPem(chunk: string): string | null {
  const trimmed = chunk.trim();
  if (trimmed.length === 0) return null;
  const pem = trimmed.includes('-----BEGIN')
    ? trimmed.replace(/\\n/g, '\n')
    : // Third accepted form: base64 of the whole PEM file. Buffer.from(…, 'base64') never
      // throws — it simply drops characters it does not know — so there is nothing to catch
      // here, and an empty catch would read as a guard that is not one.
      Buffer.from(trimmed.replace(/\s+/g, ''), 'base64').toString('utf8').trim();
  // 🔴 THE PUBLIC HALF, AND ONLY IT (invariant 2). Node's createPublicKey() accepts a
  // PRIVATE key PEM and quietly DERIVES the public half from it — so a pasted private key
  // would work perfectly, and the hub's private key would live in our environment with
  // nothing ever saying so. That is refused here, where it is still a loud 503.
  return pem.includes('-----BEGIN PUBLIC KEY-----') ? pem : null;
}

/**
 * EVERY usable public key in the variable, parsed and TYPE-CHECKED by us (invariant 8),
 * in the order the owner wrote them. An empty array means "unconfigured or unusable" —
 * the caller turns that into 'not_configured', i.e. 503.
 *
 * An unusable ENTRY (wrong type, a private key, junk) is skipped, not fatal: during a
 * rotation the list is edited by hand under pressure, and one bad line must not shut the
 * door while a good key sits right beside it. "Nothing usable at all" is still 503.
 *
 * No cap on the list length on purpose: only the owner can set this variable, an Ed25519
 * verification costs microseconds, and a cap silently ignoring the entry that happens to
 * be the live key is a worse failure than any cost it would save.
 */
function readPublicKeys(): KeyObject[] {
  const raw = process.env[HUB_TICKET_PUBLIC_KEY_ENV];
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  const keys: KeyObject[] = [];
  for (const chunk of splitKeyList(raw)) {
    const pem = toPublicKeyPem(chunk);
    if (pem === null) continue;
    let key: KeyObject;
    try {
      key = createPublicKey(pem);
    } catch {
      continue;
    }
    // Ed25519 EXACTLY. jose would also accept ed448 under 'EdDSA', and (measured on jose
    // 5.10) importSPKI(pem, 'EdDSA') accepts RSA and P-256 keys outright — so the type is
    // pinned here, where a wrong key is still a CONFIGURATION fault and not yet a 401.
    if (key.asymmetricKeyType !== 'ed25519') continue;
    keys.push(key);
  }
  return keys;
}

/** The protected header, read by US before the token reaches any library. */
function readHeader(segment: string | undefined): Record<string, unknown> | null {
  if (!segment) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A jose failure -> our machine reason (invariant 5: nothing else escapes). */
function reasonFromJose(e: unknown): HubTicketReason {
  const err = e as { code?: string; claim?: string } | null;
  switch (err?.code) {
    case 'ERR_JWT_EXPIRED':
      return 'expired';
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'bad_signature';
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return 'bad_alg_late';
    case 'ERR_JWS_INVALID':
    case 'ERR_JWT_INVALID':
      return 'bad_form';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      if (err.claim === 'aud') return 'aud_mismatch';
      if (err.claim === 'iss') return 'iss_mismatch';
      return 'bad_form';
    default:
      return 'bad_signature';
  }
}

/**
 * VERIFY A SHELL TICKET. Never throws (invariant 9); never logs the ticket itself.
 *
 * 🔴 NO ARGUMENT BUT THE TICKET. Neither the audience, nor the clock, nor the skew can be
 * passed in — and that is not asceticism: every such setting is a way to WEAKEN the check
 * from a calling file where nobody later looks for it. This module knows its own name, its
 * own tolerance and its own clock.
 */
export async function verifyHubTicket(ticket: string): Promise<HubTicketResult> {
  const nowSec = Math.floor(Date.now() / 1000);

  // --- 1. Shape — THE CHEAP TEST COMES FIRST (fix №10, 23.09.2026) ---------------
  // Reading and parsing the key used to stand here, ahead of "is this three segments at
  // all". Two prices for that order: every piece of junk sent at the endpoint bought a
  // key parse, and an anonymous probe learned "this door is/is not configured" from pure
  // garbage. Now garbage is refused on its own shape and costs nothing.
  //
  // 🔴 THE INVARIANT THAT SURVIVES THE REORDER: a request that LOOKS like a ticket still
  // gets 'not_configured' (-> 503) on an unconfigured server — "the server is not set up"
  // must never masquerade as "your ticket is forged", or a person is sent to reinstall an
  // app over our own typo. Only shapeless junk stops reaching that answer.
  if (typeof ticket !== 'string') return { ok: false, reason: 'bad_form' };
  const value = ticket.trim();
  if (value.length === 0 || value.length > HUB_TICKET_MAX_CHARS) {
    return { ok: false, reason: 'bad_form' };
  }
  const segments = value.split('.');
  if (segments.length !== 3) return { ok: false, reason: 'bad_form' };
  // Canonical base64url before anything is decoded (see B64URL_RE). The SIGNATURE segment
  // may be empty — that is what an `alg: none` token looks like, and it has to reach the
  // header guard below to die there under our own 'bad_alg'.
  if (!B64URL_RE.test(segments[0] as string) || !B64URL_RE.test(segments[1] as string)) {
    return { ok: false, reason: 'bad_form' };
  }
  const sig = segments[2] as string;
  if (sig.length > 0 && !B64URL_RE.test(sig)) return { ok: false, reason: 'bad_form' };

  // --- 2. The header, read by us (invariant 1, guard (a)) ------------------------
  const head = readHeader(segments[0]);
  if (!head) return { ok: false, reason: 'bad_form' };
  // `none` and HS256 die HERE, before the token is handed to any library, and they die
  // under OUR reason code — that is what makes this guard visible when it is removed.
  if (head['alg'] !== HUB_TICKET_ALG) return { ok: false, reason: 'bad_alg' };
  // A token does not get to say what verifies it: an embedded or referenced key is a
  // refusal, not an instruction.
  if (
    Object.hasOwn(head, 'jwk') ||
    Object.hasOwn(head, 'jku') ||
    Object.hasOwn(head, 'x5u') ||
    Object.hasOwn(head, 'x5c') ||
    Object.hasOwn(head, 'crit')
  ) {
    return { ok: false, reason: 'bad_alg' };
  }
  if (Object.hasOwn(head, 'typ') && head['typ'] !== 'JWT') {
    return { ok: false, reason: 'bad_form' };
  }

  // --- 3. Our key(s), from the environment (invariant 8) -------------------------
  // Only now, once the thing in hand actually looks like a ticket. "The server is not
  // configured" still wins over every complaint about a WELL-FORMED ticket, which is the
  // half of the old order that mattered.
  const keys = readPublicKeys();
  if (keys.length === 0) {
    // No log line here: the DOOR prints exactly one, naming the variable (auth/hub.ts).
    return { ok: false, reason: 'not_configured' };
  }

  // --- 4. Signature, issuer, audience, lifetime (invariant 1, guard (b)) ---------
  // Every configured key is tried, in order — that is what makes a hub key rotation a
  // two-step with no downtime instead of a 401 storm (invariant 8). A claim failure
  // (expired / wrong aud / wrong iss) is key-INDEPENDENT: jose checks the signature
  // first, so such a reason can only come from the key that actually signed, and we stop
  // at it instead of masking it behind the next key's 'bad_signature'.
  let payload: Record<string, unknown> | null = null;
  let failure: HubTicketReason = 'bad_signature';
  for (const key of keys) {
    try {
      const verified = await jwtVerify(value, key, {
        algorithms: [HUB_TICKET_ALG],
        issuer: HUB_TICKET_ISSUER,
        audience: HUB_TICKET_AUDIENCE,
        clockTolerance: HUB_TICKET_MAX_SKEW_SEC,
        currentDate: new Date(nowSec * 1000),
      });
      payload = verified.payload as Record<string, unknown>;
      break;
    } catch (e) {
      failure = reasonFromJose(e);
      if (failure !== 'bad_signature') break;
    }
  }
  if (payload === null) return { ok: false, reason: failure };

  // --- 5. Claims: strict shape, each with its own refusal ------------------------
  // An `aud` ARRAY is refused even where jose was happy with it: our door belongs to one
  // application, and a ticket addressed to several is not the ticket it was designed for.
  const aud = payload['aud'];
  if (typeof aud !== 'string' || aud !== HUB_TICKET_AUDIENCE) {
    return { ok: false, reason: 'aud_mismatch' };
  }
  const sub = payload['sub'];
  // STRING ONLY — no Number() anywhere near it — and it must fit users.telegram_id
  // (invariant 7 + core/telegram-id.ts).
  if (!isTelegramIdString(sub)) {
    return { ok: false, reason: 'bad_sub' };
  }
  const jti = payload['jti'];
  if (typeof jti !== 'string' || !HUB_TICKET_JTI_RE.test(jti)) {
    return { ok: false, reason: 'bad_jti' };
  }
  const iat = payload['iat'];
  const exp = payload['exp'];
  if (
    typeof iat !== 'number' ||
    !Number.isFinite(iat) ||
    typeof exp !== 'number' ||
    !Number.isFinite(exp)
  ) {
    return { ok: false, reason: 'bad_form' };
  }
  if (iat > nowSec + HUB_TICKET_MAX_SKEW_SEC) {
    return { ok: false, reason: 'issued_in_future' };
  }
  // "Signed by the hub" does not mean "lives an hour" (invariant 4).
  if (exp - iat > HUB_TICKET_TTL_SEC) {
    return { ok: false, reason: 'ttl_too_long' };
  }

  // --- 6. Snapshot: whitelist, and an unknown field is a refusal (invariant 6) ----
  let language: string | null = null;
  if (Object.hasOwn(payload, 'snapshot')) {
    const snap = payload['snapshot'];
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) {
      return { ok: false, reason: 'bad_snapshot' };
    }
    const snapshot = snap as Record<string, unknown>;
    for (const field of Object.keys(snapshot)) {
      if (!SNAPSHOT_FIELDS.includes(field)) {
        return { ok: false, reason: 'bad_snapshot' };
      }
    }
    if (Object.hasOwn(snapshot, 'language')) {
      const tag = snapshot['language'];
      // Length BEFORE the pattern: the pattern ends in an unbounded repeat, and the tag
      // is the one field of the ticket whose size the ticket cap alone does not usefully
      // bound (HUB_TICKET_MAX_LANGUAGE_CHARS explains what that cost).
      if (
        typeof tag !== 'string' ||
        tag.length > HUB_TICKET_MAX_LANGUAGE_CHARS ||
        !SNAPSHOT_LANGUAGE_RE.test(tag)
      ) {
        return { ok: false, reason: 'bad_snapshot' };
      }
      language = tag.toLowerCase();
    }
  }

  return {
    ok: true,
    identity: { telegramId: sub, app: aud, jti, issuedAt: iat, expiresAt: exp, language },
  };
}
