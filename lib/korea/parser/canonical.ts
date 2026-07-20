// lib/korea/parser/canonical.ts
//
// Pure, dependency-free helpers for choosing the in-batch CANONICAL among byte-identical reposts,
// plus the shared "live Telegram user vs bot" handle test. Extracted from parser/run.ts so the
// selection rule is unit-testable without pulling in the Anthropic SDK / db (see canonical.test.ts).
// Neon returns timestamptz as Date|string; everything here normalizes to epoch ms.

/**
 * Epoch ms of a raw row's posted_at. A missing/invalid timestamp sorts LAST (+Infinity) so a row
 * that has a real posted_at is always preferred over one that does not.
 */
export function postedMs(r: Record<string, unknown>): number {
  const p = r.posted_at;
  if (p == null) return Number.POSITIVE_INFINITY;
  const t = new Date(p as string | Date).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Order two raw rows EARLIEST-first: by posted_at (missing/invalid last), then id as a stable
 * tie-break so the choice is deterministic across runs.
 */
export function cmpEarliest(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const pa = postedMs(a);
  const pb = postedMs(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
  const ia = a.id as string;
  const ib = b.id as string;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** Normalize a Telegram @handle: coerce to string, trim, strip leading @(s). '' when absent/blank. */
export function normalizeHandle(raw: unknown): string {
  return (typeof raw === 'string' ? raw : '').trim().replace(/^@+/, '');
}

/**
 * True when a sender_username belongs to a LIVE Telegram user we can DM: a non-empty handle that is
 * NOT a bot. Bots' handles end in 'bot' (case-insensitive) and do not answer DMs. This is the SINGLE
 * source of the bot test — the parser's sender-username contact fallback imports it too, so the
 * canonical choice and the contact it enables can never drift apart.
 */
export function isLiveUserHandle(raw: unknown): boolean {
  const h = normalizeHandle(raw);
  return h !== '' && !h.toLowerCase().endsWith('bot');
}

/**
 * Choose the in-batch CANONICAL among byte-identical reposts.
 *
 * Owner rule (2026-07-20): "до ИИ отправлять не абы какую копию, а ту, где автор — живой
 * телеграм-пользователь, а не бот; если такой в копиях нет — тогда уже от бота". So we prefer a
 * copy whose AUTHOR is a live Telegram user (has a non-bot @username) — that lets the published
 * card carry a real, DM-able contact instead of just "открыть в канале". A bot/anonymous copy
 * becomes the canonical ONLY when no copy in the group has a live-user author. Within the chosen
 * class the EARLIEST posting wins (cmpEarliest).
 *
 * Pure + deterministic (unit-tested). Precondition: rows.length >= 1 (callers group by text_hash,
 * so a group is never empty).
 */
export function pickCanonical<T extends Record<string, unknown>>(rows: T[]): T {
  const live = rows.filter((r) => isLiveUserHandle(r.sender_username));
  const pool = live.length > 0 ? live : rows;
  return [...pool].sort(cmpEarliest)[0]!;
}
