// lib/korea/parser/verdict-cache.ts
//
// AI VERDICT CACHE (owner rule 2026-07-21). Half of the residual that survives the free filters is
// byte-exact repeats of a message the AI ALREADY judged a reject — often ONE short spam/chit-chat line
// posted many times an hour. The raw_messages.text_hash dedup deliberately IGNORES short texts (its
// 40-char floor sends them to the model as "unique", so two DIFFERENT short vacancies never collide) —
// which is exactly why those short repeats keep hitting the model.
//
// This cache is a SEPARATE contour: a FUZZY "letter-skeleton" hash (verdictHash) — lowercase, keep ONLY
// letters (Cyrillic/Latin/Hangul) and drop everything else (digits, emoji, punctuation, whitespace,
// zero-width marks) — storing only genuine NON-vacancy reject verdicts. Before the AI batch, the parser
// looks up every survivor's verdict-hash; a hit is skipped with the cached reject_reason and never reaches
// the model. After the AI, a fresh non-vacancy reject is written back. Vacancies and low_confidence are
// NEVER cached (the first copy of anything the model might keep is always judged fresh; vacancies ride the
// normal dedup contour).
//
// WHY a skeleton (owner rule 2026-07-21): bots mimic a message to dodge exact dedup by swapping only a
// digit (8000→9000) or an emoji (🐠→🏝). The skeleton reduces those to ONE family, so the SECOND such copy
// reuses the first's reject verdict. CONSCIOUS TRADE-OFF: two texts that differ ONLY by digits/emoji share
// one reject verdict — acceptable because ONLY rejects are cached and the FIRST copy is always judged by
// the AI, so a genuine vacancy is still judged fresh (a vacancy is never cached; low_confidence is never
// cached). A skeleton with NO letters at all (pure digits/emoji/phone) is NOT cached (verdictHash → null):
// such rows are the structural/spam pre-filter's job, not the verdict cache's.
//
// The two contours must NEVER mix: raw_messages.text_hash keeps its 40-char floor over normalizeForHash
// (vacancy dedup, byte-exact); THIS hash is the floor-less letter-skeleton (short-repeat reject dedup).
//
// BEST-EFFORT by design (mirrors ai-usage.ts / reject-log.ts): every read/write is try-wrapped and
// swallowed — a cache fault must NEVER break a parse. On a read fault nothing is skipped (the batch just
// goes to the model as before); on a write fault the verdict simply is not remembered this time.

import { createHash } from 'node:crypto';
import { getSql } from '../core/db.js';

type Sql = ReturnType<typeof getSql>;

// Letters kept in the verdict skeleton: Cyrillic, Latin, Hangul. Everything else — digits, emoji,
// punctuation, whitespace, zero-width marks, AND any other script (the Greek/CJK look-alikes emoji-carpet
// bots love) — is stripped, so a copy that mimics only a digit (8000→9000) or an emoji (🐠→🏝) collapses
// onto the SAME family. \p{Script=…} needs the /u flag (Node 20+ supports Unicode script properties).
const NON_SKELETON = /[^\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Hangul}]/gu;

// PHONE MARKER (owner risk-review 2026-07-21): the skeleton drops digits, so "same text + an added
// phone number" would otherwise collapse onto a phone-less copy and inherit its reject — the ONE
// realistic path for a genuinely improved repost (contact added) to be swallowed by the cache.
// A Korean mobile (010/011/016-019) or +82 international run in the ORIGINAL text flips the cache
// key, so the phone-less and phone-carrying variants are never the same family. Salary runs
// ("2 500 000 вон") deliberately do NOT match (they don't start with 01x/+82); a false marker would
// only SPLIT a family (less caching) — fails safe, never merges more.
const PHONE_RE = /(01[016789][\s\-.()]*\d{3,4}[\s\-.()]*\d{4})|(\+\s?82[\d\s\-.()]{7,})/;

/**
 * Verdict-cache hash: a FUZZY "letter-skeleton" of the text — lowercase, keep ONLY letters (Cyrillic/
 * Latin/Hangul), drop digits/emoji/punctuation/whitespace/zero-width and every other script. NO
 * minimum-length floor (a short exact-repeat line is exactly what we collapse here). Returns null when the
 * skeleton is EMPTY (no letters at all — pure digits/emoji/whitespace/phone): such rows are NOT cached
 * (the structural/spam pre-filter handles them) and null also means "nothing to key on". This is a
 * DIFFERENT contour from parser/texthash.ts `textHash` (byte-exact + MIN_TEXT_HASH_LEN floor) — do NOT
 * merge them. TRADE-OFF: texts differing only by digits/emoji share ONE reject verdict — safe, since only
 * rejects are cached and the first copy is always judged fresh (see the module header).
 */
export function verdictHash(text: string | null | undefined): string | null {
  if (!text) return null;
  const skeleton = text.replace(NON_SKELETON, '').toLowerCase();
  if (skeleton.length === 0) return null;
  // The marker is appended AFTER the empty-skeleton guard: a pure-phone message still returns null.
  const keyed = PHONE_RE.test(text) ? skeleton + 'P' : skeleton;
  return createHash('sha256').update(keyed, 'utf8').digest('hex');
}

/**
 * Cache POLICY gate (pure): a verdict may be remembered ONLY when it is a genuine NON-vacancy reject.
 * NEVER cache a vacancy (those ride the normal dedup contour and their first copy is always judged fresh)
 * and NEVER cache 'low_confidence' (the visible "Не проверено" tab — its first copy must always reach a
 * human/AI, and repeats there are handled by the vacancy dedup contour). Kept pure so the caller's write
 * path is unit-testable without a DB.
 */
export function shouldCacheVerdict(isVacancy: boolean, rejectReason: string): boolean {
  return !isVacancy && rejectReason !== 'low_confidence';
}

/**
 * Look up cached reject verdicts for a set of verdict-hashes in ONE select. Returns a Map hash ->
 * reject_reason for the hits. Best-effort: a read fault (or the table missing in a deploy-before-migrate
 * window) returns an EMPTY map, so the whole batch falls through to the model exactly as before.
 */
export async function lookupVerdictCache(sql: Sql, hashes: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (hashes.length === 0) return out;
  try {
    const rows = (await sql`
      select text_hash, reject_reason from ai_verdict_cache
      where text_hash = any(${hashes}::text[])`) as unknown as { text_hash: string; reject_reason: string }[];
    for (const r of rows) out.set(r.text_hash, r.reject_reason);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[parser] verdict-cache lookup skipped:', err instanceof Error ? err.message : String(err));
  }
  return out;
}

/**
 * Bump n / last_seen for the DISTINCT hashes we just served from cache (a repeat skipped without the
 * model). Best-effort — a failure never affects the skip that already happened.
 */
export async function touchVerdictCache(sql: Sql, hashes: string[]): Promise<void> {
  if (hashes.length === 0) return;
  try {
    await sql`
      update ai_verdict_cache set n = n + 1, last_seen = now()
      where text_hash = any(${hashes}::text[])`;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[parser] verdict-cache touch skipped:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Remember a fresh non-vacancy reject verdict so an EXACT repeat skips the model next time. Additive
 * upsert (a within-batch collision or a race just bumps n). Best-effort — never throws. The CALLER is
 * responsible for the policy gate (never low_confidence, never a vacancy).
 */
export async function upsertVerdictCache(sql: Sql, hash: string, rejectReason: string): Promise<void> {
  try {
    await sql`
      insert into ai_verdict_cache (text_hash, reject_reason, n, last_seen)
      values (${hash}, ${rejectReason}, 1, now())
      on conflict (text_hash) do update set
        n = ai_verdict_cache.n + 1,
        last_seen = now(),
        reject_reason = excluded.reject_reason`;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[parser] verdict-cache upsert skipped:', err instanceof Error ? err.message : String(err));
  }
}
