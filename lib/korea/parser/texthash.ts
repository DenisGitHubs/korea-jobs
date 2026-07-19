// lib/korea/parser/texthash.ts
//
// Deterministic text hashing for PRE-AI exact-duplicate dedup. The same job posting is often
// reposted byte-for-byte across several channels (e.g. @odinvkoree and @Korea_Vakansii). We
// collapse those copies BEFORE the parser calls the model, so no tokens are spent parsing the
// same text twice. This is the SINGLE SOURCE of the normalization so the runtime parser
// (lib/korea/parser/run.ts) and the one-off backfill (db/backfill_raw_text_hash.mts) can never
// diverge — the hash is computed in JS, never in SQL.

import { createHash } from 'node:crypto';

// Minimum NORMALIZED length to be eligible for hashing. Very short texts ("Вопросы в ЛС",
// "Работа есть, пишите") collide across genuinely DIFFERENT vacancies, so we deliberately do
// NOT hash them (hash = null => "don't dedup, send to the AI as-is").
export const MIN_TEXT_HASH_LEN = 40;

// Zero-width / BOM characters stripped before hashing, so a repost that differs only by an
// invisible marker still collapses to one hash: U+FEFF BOM/ZWNBSP, U+200B ZWSP, U+200C ZWNJ,
// U+200D ZWJ. Written as escapes (the chars are invisible in source). JS \s already covers NBSP
// and the Unicode space separators, but NOT these zero-width code points.
const ZERO_WIDTH = /[\uFEFF\u200B\u200C\u200D]/g;

/**
 * Deterministic normalization for exact-duplicate detection: drop zero-width/BOM chars,
 * collapse every whitespace run (spaces, tabs, newlines) to a single space, trim, lowercase.
 * Pure + dependency-free so runtime and backfill produce identical output for identical input.
 */
export function normalizeForHash(text: string): string {
  return text
    .replace(ZERO_WIDTH, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * sha256-hex of the normalized text, or null when the text is empty or too short to hash
 * safely (see MIN_TEXT_HASH_LEN). null means "not deduped — treat as unique".
 */
export function textHash(text: string | null | undefined): string | null {
  if (!text) return null;
  const norm = normalizeForHash(text);
  if (norm.length < MIN_TEXT_HASH_LEN) return null;
  return createHash('sha256').update(norm, 'utf8').digest('hex');
}
