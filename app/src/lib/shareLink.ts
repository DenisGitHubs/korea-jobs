/**
 * Vacancy share deep-link — the SINGLE place that builds and parses the combined
 * `startapp` payload used by the "Share" button on a vacancy.
 *
 * ── The shared start_param contract (agreed with the backend) ─────────────────
 * A referral code is a `users.public_id`: exactly 16 lowercase hex chars. The
 * EXISTING plain referral link carries it bare:
 *
 *     ?startapp=<refcode16hex>            → pure referral (unchanged, still works)
 *
 * A shared VACANCY link additionally carries the vacancy id (a UUID) so the app can
 * open that exact card, WHILE still crediting the sharer's referral code:
 *
 *     ?startapp=v<vacancyUuidHex32>r<refcode16hex>
 *
 *   * prefix "v" + the vacancy UUID with dashes stripped (32 hex)
 *   * optional "r" + the 16-hex referral code
 *   * only chars [a-z0-9] + the literal tags v/r → all Telegram-legal, length ≤ 50
 *
 * Because a 16-hex referral code never starts with the literal "v", the two forms
 * are unambiguous. Degradation is built in: no "r<code>" part → vacancy opens with
 * no attribution; a bare 16-hex param → the old referral path, no vacancy nav.
 *
 * Split of responsibility:
 *   * FRONTEND (this file) extracts the vacancy id → deep-navigates to the card.
 *   * BACKEND extracts the refcode from the SAME start_param → binds the referral
 *     (context.ts `normalizeRefCode` must also accept the combined form; the plain
 *     16-hex path is unchanged). The client never does attribution itself.
 */
import { api } from '../shared/api/client';

const VACANCY_TAG = 'v';
const REF_TAG = 'r';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A referral code = users.public_id: exactly 16 hex chars (mirrors the backend). */
const REF_CODE_RE = /^[0-9a-f]{16}$/i;
/** The combined form: v<32hex>[ r<16hex> ]. */
const COMBINED_RE = /^v([0-9a-f]{32})(?:r([0-9a-f]{16}))?$/i;

/** UUID → 32 hex (dashes stripped, lowercased). null when not a UUID (e.g. the mock's `v01`). */
function uuidToHex(id: string): string | null {
  const s = id.trim().toLowerCase();
  return UUID_RE.test(s) ? s.replace(/-/g, '') : null;
}

/** 32 hex → canonical dashed UUID (8-4-4-4-12). */
function hexToUuid(hex: string): string {
  return hex.toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

/**
 * Build the combined `startapp` payload for a vacancy (+ optional referral code).
 * Returns null when the id is not a UUID (browser mock ids like `v01`) so the caller
 * can gracefully fall back to the plain referral link.
 */
export function buildShareStartParam(vacancyId: string, refCode?: string | null): string | null {
  const hex = uuidToHex(vacancyId);
  if (!hex) return null;
  let sp = `${VACANCY_TAG}${hex}`;
  if (refCode && REF_CODE_RE.test(refCode)) sp += `${REF_TAG}${refCode.toLowerCase()}`;
  return sp;
}

export interface ParsedShareParam {
  /** Canonical dashed UUID of the shared vacancy, or null when the param carries none. */
  vacancyId: string | null;
  /** Referral code carried alongside (informational on the client; binding is server-side). */
  refCode: string | null;
}

/**
 * Client mirror of the backend split: pull the vacancy id (and, informationally, the
 * ref code) out of a `startapp` param. A bare 16-hex param is a pure referral code —
 * it returns { vacancyId: null } here (nothing to navigate to; the server binds it).
 */
export function parseShareStartParam(sp: string | null | undefined): ParsedShareParam {
  if (typeof sp !== 'string') return { vacancyId: null, refCode: null };
  const m = sp.trim().match(COMBINED_RE);
  if (!m) return { vacancyId: null, refCode: null };
  return { vacancyId: hexToUuid(m[1]), refCode: m[2] ? m[2].toLowerCase() : null };
}

/**
 * Produce the final share URL by swapping the `startapp` value of the server-minted
 * referral link. Reusing that link keeps the authoritative bot username + app
 * short-name (backend config) — nothing about the t.me base is hardcoded here.
 */
export function buildVacancyShareLink(referralLink: string, startParam: string): string {
  try {
    const u = new URL(referralLink);
    u.searchParams.set('startapp', startParam);
    return u.toString();
  } catch {
    // Not an absolute URL (defensive) — do a string-level swap of the startapp value.
    return /startapp=/.test(referralLink)
      ? referralLink.replace(/startapp=[^&]*/, `startapp=${startParam}`)
      : `${referralLink}${referralLink.includes('?') ? '&' : '?'}startapp=${startParam}`;
  }
}

// ── Referral info (code + server link), fetched once per session ────────────────
// The share link needs the caller's own referral code AND the server-built link base
// (bot + app short-name). Both come from GET /referral. Memoized: a single in-flight
// request, cached on success, retried after a failure — so opening many cards and
// tapping Share never refetches, and a share tap never fires a duplicate request.

export interface ReferralInfo {
  code: string;
  link: string;
}

let cached: ReferralInfo | null = null;
let inFlight: Promise<ReferralInfo | null> | null = null;

/** Synchronous read of the cached referral info (null until the first load resolves). */
export function getCachedReferral(): ReferralInfo | null {
  return cached;
}

/** Load (once) the caller's referral code + link. Resolves null on failure (share then falls back). */
export function loadReferral(): Promise<ReferralInfo | null> {
  if (cached) return Promise.resolve(cached);
  if (!inFlight) {
    inFlight = api
      .referral()
      .then((r) => {
        cached = { code: r.code, link: r.link };
        return cached;
      })
      .catch(() => {
        inFlight = null; // allow a later retry
        return null;
      });
  }
  return inFlight;
}
