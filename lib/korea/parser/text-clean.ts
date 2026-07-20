// lib/korea/parser/text-clean.ts
//
// cleanForAi(text): collapse emoji noise BEFORE the text is handed to the model, to trim the
// input tokens spent on decorative emoji "carpets" / dividers that carry no signal. This is the
// ONLY place the AI input is touched — the ORIGINAL raw text still feeds description, the dedup
// hash (parser/texthash.ts), the takedown/content hashes and every other persistence path in
// parser/run.ts, so cleaning here can never move a dedup bucket or a stored card.
//
// PRECISION over recall (same stance as spamfilter.ts): we only touch near-certain decoration and
// never a semantic emoji. Single and PAIRED emoji are meaningful (🏠✅ = housing+yes, 💰 = pay) and
// are left untouched; only a RUN of 3+ is treated as decoration. Country FLAGS (🇰🇷🇷🇺, visa/nation
// signal — see Skills/Рома/ai-cost-haiku) are deliberately excluded from divider removal.
//
// What it does, in order:
//   1. strip zero-width chars (ZWSP/ZWNJ/BOM) and variation selectors (U+FE0E/U+FE0F);
//   2. strip STRAY ZWJ (a U+200D not flanked by pictographs on BOTH sides) — a composite ZWJ
//      sequence (👨‍👩‍👧) is kept whole, and no orphan ZWJ "half-emoji" garbage is ever left;
//   3. collapse a run of 3+ of the SAME emoji unit (spaces between allowed: "🎾 🎾 🎾") to one;
//   4. drop a LINE that has NO letters/digits and holds a run of 3+ adjacent (non-flag) emoji —
//      a pure decorative divider like "✨🎈✨🎈";
//   5. collapse 3+ blank lines into one.
// Plain text with no emoji noise comes out byte-for-byte identical.
//
// Every regex is built from a RegExp constructor with explicit \u escapes so NO literal invisible
// code point ever lives in this source file (they are impossible to review or diff safely).

const ZWJ = '\\u200D'; // zero-width joiner — the composite-emoji glue
const RI = '[\\u{1F1E6}-\\u{1F1FF}]'; // a regional-indicator symbol (a flag is a PAIR of these).
// Explicit range, not \p{Regional_Indicator}, so no Unicode-property-name support is assumed.

// One emoji "unit". Two shapes: a country FLAG (a pair of regional indicators) OR a pictographic
// cluster (a base pictograph plus optional skin-tone modifiers and ZWJ-joined continuations, so a
// composite family/couple emoji counts as ONE unit — see step 2).
const EMOJI_UNIT_SRC =
  `(?:${RI}${RI}|\\p{Extended_Pictographic}(?:[\\u{1F3FB}-\\u{1F3FF}]|${ZWJ}\\p{Extended_Pictographic})*)`;

// Non-flag pictographic unit only — used for divider detection so a line of country flags (a real
// signal) is NEVER removed, while a decorative "✨🎈✨🎈" row is.
const PICTO_UNIT_SRC =
  `\\p{Extended_Pictographic}(?:[\\u{1F3FB}-\\u{1F3FF}]|${ZWJ}\\p{Extended_Pictographic})*`;

// Zero-width + variation selectors to delete outright (NOT U+200D — handled specially so composite
// emoji survive). U+200B ZWSP, U+200C ZWNJ, U+FEFF BOM/ZWNBSP, U+FE0E/U+FE0F VS15/VS16.
const INVISIBLE_RE = new RegExp('[\u200B\u200C\uFEFF\uFE0E\uFE0F]', 'g');

// A ZWJ (U+200D) with no pictograph AFTER it, and one with no pictograph BEFORE it. Applied as two
// passes so any ZWJ not flanked by pictographs on BOTH sides is removed, while a ZWJ inside a real
// composite (pictograph on each side) is kept — no orphan ZWJ garbage remains.
const ZWJ_NO_PICTO_AFTER = new RegExp(`${ZWJ}(?!\\p{Extended_Pictographic})`, 'gu');
const ZWJ_NO_PICTO_BEFORE = new RegExp(`(?<!\\p{Extended_Pictographic})${ZWJ}`, 'gu');

// Collapse 3+ of the SAME emoji unit (whitespace between allowed) to a single one. The backref \1
// requires an IDENTICAL unit, so different emoji ("🏠✅") never collapse, and an exact PAIR
// ("🏠🏠") stays (needs 2 MORE after the first = 3 total to fire).
const SAME_EMOJI_RUN = new RegExp(`(${EMOJI_UNIT_SRC})(?:\\s*\\1){2,}`, 'gu');

// A run of 3+ adjacent (no whitespace) non-flag pictographs — the fingerprint of a decorative
// divider line. Adjacency is what separates "✨🎈✨🎈" (a run of 4 → divider) from "🏠✅ 🍱✅"
// (two pairs, max run 2 → kept). Non-global so .test() is stateless and reusable.
const PICTO_RUN_3 = new RegExp(`(?:${PICTO_UNIT_SRC}){3,}`, 'u');

// Any letter or digit — a line that has one is content, never a divider.
const HAS_CONTENT = /[\p{L}\p{N}]/u;

// 3+ consecutive line breaks (blank lines may carry spaces/tabs) collapse to one blank line.
const BLANK_LINES_3 = /\n[ \t]*(?:\n[ \t]*){2,}/g;

/** True when a line is a pure decorative emoji divider (no letters/digits, a 3+ pictograph run). */
function isDividerLine(line: string): boolean {
  if (HAS_CONTENT.test(line)) return false;
  return PICTO_RUN_3.test(line);
}

/**
 * Normalize a raw message for the MODEL only (never for storage/dedup — see file header).
 * Idempotent and safe on any string; returns '' for empty/nullish input.
 */
export function cleanForAi(text: string): string {
  if (!text) return '';

  let out = text
    .replace(INVISIBLE_RE, '')
    .replace(ZWJ_NO_PICTO_AFTER, '')
    .replace(ZWJ_NO_PICTO_BEFORE, '')
    .replace(SAME_EMOJI_RUN, '$1');

  // Drop divider lines. split/join on '\n' is identity for kept lines (a trailing '\r' rides along
  // untouched), so non-divider content stays byte-for-byte; only whole divider lines disappear.
  if (out.includes('\n')) {
    out = out
      .split('\n')
      .filter((line) => !isDividerLine(line))
      .join('\n');
  } else if (isDividerLine(out)) {
    out = '';
  }

  return out.replace(BLANK_LINES_3, '\n\n');
}
