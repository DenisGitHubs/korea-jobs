// lib/korea/core/start-param.ts
//
// The single source of truth for parsing a Telegram deep-link start_param
// (Mini App `startapp=` and bot `/start <code>`). Pure, no I/O, no env, no throw:
// any malformed/absent input resolves to "nothing" so attribution can never latch
// onto a partial/injected match.
//
// Telegram allows only [A-Za-z0-9_-] in start_param (≤ 512 chars). Two shapes are
// understood; they are unambiguous because the tag letters `v`/`r` are NOT hex digits,
// so a bare hex code can never be mistaken for a tagged one and vice-versa:
//
//   1. LEGACY REFERRAL (unchanged):  <refcode>
//        refcode = 16 lowercase hex  == users.public_id
//        e.g.  a1b2c3d4e5f60718                         -> { refCode }
//
//   2. VACANCY SHARE ("Поделиться вакансией"):  v<vacancyId>[r<refCode>]
//        vacancyId = 32 hex  == a UUID with the dashes stripped (8-4-4-4-12)
//        refCode   = 16 hex  == users.public_id of the inviter (OPTIONAL)
//        e.g.  v0f8c2a1b3d4e4f5a6b7c8d9e0f1a2b3c4ra1b2c3d4e5f60718
//                                                        -> { vacancyId, refCode }
//        e.g.  v0f8c2a1b3d4e4f5a6b7c8d9e0f1a2b3c4    (sharer had no ref / not logged in)
//                                                        -> { vacancyId }
//
// Degradation: only one part present still resolves that part; anything else -> {}.
// The backend only ever consumes `refCode` (referral attribution); `vacancyId` is
// carried for the FRONT-END to open the shared vacancy (front re-inserts the dashes).

/** Legacy bare referral code == users.public_id (encode(gen_random_bytes(8),'hex'), 16 hex). */
const REF_CODE_RE = /^[0-9a-f]{16}$/i;

/**
 * Vacancy-share deep link: `v` + vacancy UUID (32 hex, no dashes) + optional `r` + referral
 * code (16 hex). Anchored and length-exact — a partial/garbled variant matches nothing.
 */
const SHARE_RE = /^v([0-9a-f]{32})(?:r([0-9a-f]{16}))?$/i;

export interface StartParam {
  /** Inviter referral code (16 lowercase hex), when the link carried one. */
  refCode?: string;
  /** Shared vacancy id as 32 lowercase hex (UUID without dashes); FRONT-END only. */
  vacancyId?: string;
}

/**
 * Parse any start_param into its known parts. Returns `{}` for absent/garbage input.
 * Never throws; case-insensitive; result is normalized to lowercase hex.
 */
export function parseStartParam(raw: string | null | undefined): StartParam {
  if (typeof raw !== 'string') return {};
  const s = raw.trim();
  if (!s) return {};

  // Vacancy share (may embed a referral). Checked first for intent, though the `v`
  // tag already makes it disjoint from a bare hex refcode.
  const share = SHARE_RE.exec(s);
  if (share) {
    const out: StartParam = { vacancyId: share[1]!.toLowerCase() };
    if (share[2]) out.refCode = share[2].toLowerCase();
    return out;
  }

  // Legacy bare referral code.
  if (REF_CODE_RE.test(s)) return { refCode: s.toLowerCase() };

  return {};
}

/**
 * Extract ONLY the referral code from any start_param (bare or vacancy-share), normalized
 * to lowercase, or null when absent/malformed. This is the sole attribution input consumed
 * by the auth upsert and the bot `/start` handler — its contract (16-hex-or-null) is
 * unchanged; it now simply also sees the code embedded in a vacancy-share link.
 */
export function normalizeRefCode(raw: string | null | undefined): string | null {
  return parseStartParam(raw).refCode ?? null;
}
