// lib/korea/core/start-param.ts
//
// The single source of truth for parsing a Telegram deep-link start_param
// (Mini App `startapp=` and bot `/start <code>`). Pure, no I/O, no env, no throw:
// any malformed/absent input resolves to "nothing" so attribution can never latch
// onto a partial/injected match.
//
// Telegram allows only [A-Za-z0-9_-] in start_param (≤ 512 chars for `startapp`, ≤ 64 for
// the bot's `?start=` — every shape below stays under 64 so ONE link works for both). Three
// shapes are understood; they are unambiguous because the tag letters `v`/`r` are NOT hex
// digits and `_` is not a hex digit either, so a bare hex code can never be mistaken for a
// tagged one and vice-versa:
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
//   3. ACQUISITION SOURCE (campaign label, 2026-08-01):  ads_<slug> | s_<slug>
//        4..32 chars overall, [A-Za-z0-9_-] after the prefix, first char after the prefix is a
//        letter/digit. Normalized to lowercase with `-` folded to `_`, so one campaign cannot
//        split into two buckets over a dash.
//        e.g.  ads_ru1 -> { source: 'ads_ru1' } · s_flyer -> { source: 's_flyer' }
//        Written to users.acq_source ON INSERT ONLY (see core/context.ts) — it answers
//        "where did this NEW person come from", never re-attributes an existing account.
//        SHAPE IS NOT PERMISSION: since 02.08.2026 a parsed label is stored only if the owner
//        approved it (allow-list in core/acq-source.ts). This module still says "this looks
//        like a label"; whether that label may be RECORDED is decided there, in one place.
//
// WHY TWO PREFIXES, AND WHY THE LABEL IS THE WHOLE PARAM:
//   * `ads_` is what the owner's Telegram Ads brief (_docs/ads/telegram-ads-brief.md) already
//     tells him to paste into «URL to promote» (`?startapp=ads_ru1`). Not accepting it would
//     silently drop the counts of a campaign that may already be running — the very bug we fix.
//   * `s_` covers every OTHER channel the same mechanism will label later (посев в чатах,
//     блогер, QR на флаере), so nobody has to write "ads_" about something that is not an ad.
//   * A prefix is REQUIRED (never a bare word): it is the marker that separates a deliberate
//     label from junk, and it keeps the shape disjoint from any future format.
//   * The stored/reported label is the ENTIRE param, not the part after the prefix: what the
//     owner typed into the ad cabinet is exactly what /stats prints back («ads_ru1 — 12 человек»).
//     No mental translation, nothing to mis-remember.
//
// A source tag is deliberately NOT combinable with a referral / vacancy-share link: a person
// who arrives through somebody's referral link WAS acquired by that referral, and the graph
// (users.referred_by) already says so. Allowing both would double-count the same user in two
// acquisition reports at once. One user = one acquisition channel.
//
// Degradation: only one part present still resolves that part; anything else -> {}.
// The backend consumes `refCode` (referral attribution) and `source` (acquisition label);
// `vacancyId` is carried for the FRONT-END to open the shared vacancy (front re-inserts the dashes).

/** Legacy bare referral code == users.public_id (encode(gen_random_bytes(8),'hex'), 16 hex). */
const REF_CODE_RE = /^[0-9a-f]{16}$/i;

/**
 * Vacancy-share deep link: `v` + vacancy UUID (32 hex, no dashes) + optional `r` + referral
 * code (16 hex). Anchored and length-exact — a partial/garbled variant matches nothing.
 */
const SHARE_RE = /^v([0-9a-f]{32})(?:r([0-9a-f]{16}))?$/i;

/** Canonical dashed UUID (8-4-4-4-12), the shape the vacancy id arrives in from the DB / client. */
const UUID_DASHED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Acquisition-source label: `ads_<slug>` (advertising) or `s_<slug>` (any other channel). The
 * char right after the prefix must be a letter/digit, so `ads__x` / `s_-x` are rejected — a typo
 * must resolve to NOTHING rather than create a junk bucket. Anchored, and `_` is not a hex digit,
 * so it can never overlap the two hex shapes above. Length is checked separately (SOURCE_LABEL_*)
 * to keep one readable rule instead of per-prefix counts inside the pattern.
 */
const SOURCE_RE = /^(?:ads|s)_[a-z0-9][a-z0-9_-]*$/i;

/** Deep-link tags — kept next to SHARE_RE so the builder and parser share one format. */
const VACANCY_TAG = 'v';
const REF_TAG = 'r';
/** Recognised acquisition prefixes, in the order the owner is meant to reach for them. */
export const SOURCE_PREFIXES = ['ads_', 's_'] as const;
/** Bounds of a WHOLE label (prefix included). The ceiling is mirrored by the column comment. */
export const SOURCE_LABEL_MIN = 4;
export const SOURCE_LABEL_MAX = 32;

export interface StartParam {
  /** Inviter referral code (16 lowercase hex), when the link carried one. */
  refCode?: string;
  /** Shared vacancy id as 32 lowercase hex (UUID without dashes); FRONT-END only. */
  vacancyId?: string;
  /** Acquisition label from a campaign link (`ads_…`/`s_…`), lowercase, `-` folded to `_`. */
  source?: string;
}

/**
 * Parse any start_param into its known parts. Returns `{}` for absent/garbage input.
 * Never throws; case-insensitive; every part comes back lowercased (hex codes as hex,
 * an acquisition label with `-` folded to `_`).
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

  // Acquisition label (campaign). Disjoint from both hex shapes: `_` is not a hex digit, and
  // neither prefix starts with `v`. The label kept is the WHOLE param — see the header.
  if (s.length >= SOURCE_LABEL_MIN && s.length <= SOURCE_LABEL_MAX && SOURCE_RE.test(s)) {
    return { source: s.toLowerCase().replace(/-/g, '_') };
  }

  // Legacy bare referral code.
  if (REF_CODE_RE.test(s)) return { refCode: s.toLowerCase() };

  return {};
}

/**
 * Build the vacancy-share `startapp` payload `v<vacancyHex32>[r<refCode16>]` — the inverse of
 * `parseStartParam`, and the server-side twin of the front-end's `buildShareStartParam`
 * (app/src/lib/shareLink.ts). `vacancyId` is a canonical dashed UUID; the dashes are stripped to
 * the 32-hex form. The referral code is appended ONLY when it is a valid 16-hex `public_id`, so a
 * missing/garbage code degrades to a vacancy-only link (still opens the card, no attribution).
 * Returns null when the vacancy id is not a UUID, letting the caller fall back to a plain link.
 */
export function buildShareStartParam(vacancyId: string, refCode?: string | null): string | null {
  const s = vacancyId.trim().toLowerCase();
  if (!UUID_DASHED_RE.test(s)) return null;
  let sp = `${VACANCY_TAG}${s.replace(/-/g, '')}`;
  if (refCode && REF_CODE_RE.test(refCode)) sp += `${REF_TAG}${refCode.toLowerCase()}`;
  return sp;
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

/**
 * Extract ONLY the acquisition label from any start_param, or null when the link carries none.
 * The twin of `normalizeRefCode`: it answers "does this link carry a well-FORMED label", nothing
 * more.
 *
 * DO NOT WRITE users.acq_source FROM THIS. `startapp` is a public URL tail, so a well-formed
 * label may still be a stranger's invention or a special category of personal data. The write
 * paths (Mini App auth upsert + bot `/start`) both go through `resolveAcqSource`
 * (core/acq-source.ts), which additionally checks the owner's allow-list. Keeping that check in
 * ONE place is the only reason the two entry paths cannot drift apart.
 */
export function normalizeAcqSource(raw: string | null | undefined): string | null {
  return parseStartParam(raw).source ?? null;
}

/**
 * Turn a human-typed campaign name into the exact `startapp`/`start` payload to paste into the ad
 * cabinet, or null when it cannot be made legal (Cyrillic, too short/long, punctuation-only).
 * Spaces/dots/dashes fold to `_`, and a name with no recognised prefix gets the generic `s_` —
 * so «Флаер» fails loudly (report it to the owner) while «flyer» becomes `s_flyer` instead of
 * silently producing an unlabelled link. Round-trips through `parseStartParam`.
 */
export function buildSourceStartParam(label: string): string | null {
  if (typeof label !== 'string') return null;
  const base = label.trim().toLowerCase().replace(/[\s.-]+/g, '_');
  const withPrefix = SOURCE_PREFIXES.some((p) => base.startsWith(p)) ? base : `s_${base}`;
  return withPrefix.length >= SOURCE_LABEL_MIN &&
    withPrefix.length <= SOURCE_LABEL_MAX &&
    SOURCE_RE.test(withPrefix)
    ? withPrefix
    : null;
}
