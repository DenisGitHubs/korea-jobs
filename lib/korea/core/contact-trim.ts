// lib/korea/core/contact-trim.ts
//
// Truncate a multi-contact string on a CONTACT boundary, never mid-number.
//
// Since 2026-07-19 contact_raw may carry SEVERAL contacts joined by " · " (a space, a
// middle-dot U+00B7, a space) — see lib/korea/parser/prompt.ts and lib/korea/ads/input.ts.
// A blind slice(0, max) can cut in the middle of a phone ("... 010-33") and surface a broken
// contact. This trims back to the last COMPLETE " · " boundary that fits inside `max`, so only
// whole contacts survive.
//
// SINGLE source of truth for BOTH write paths — the AI parser (parser/run.ts) and the user-ad
// form (ads/input.ts) — so they clamp contact_raw identically. Pure (no I/O) -> unit-testable.

/** The contact separator: space, middle-dot U+00B7, space. MUST match parser/prompt.ts + client. */
const SEP = ' · ';

/**
 * Clamp a (possibly multi-)contact string to at most `max` chars WITHOUT splitting a contact.
 *  - length <= max            -> returned unchanged.
 *  - otherwise                -> cut back to the last full " · " boundary that fits inside `max`
 *                                (drops the trailing separator and the partial contact after it).
 *  - first contact > `max`     -> hard cut at `max` (no boundary fits; we don't invent one).
 */
export function truncateContacts(value: string, max = 300): string {
  if (value.length <= max) return value;
  const window = value.slice(0, max);
  const idx = window.lastIndexOf(SEP);
  if (idx <= 0) return value.slice(0, max); // first contact alone longer than max -> hard cut
  return value.slice(0, idx);
}
