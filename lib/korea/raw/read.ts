// lib/korea/raw/read.ts
//
// GET /api/raw — the "UNVERIFIED" stream: raw captured messages the parser could NOT
// confidently turn into a vacancy yet. We show the ORIGINAL text (scrubbed) marked
// "не проверено", so a message that might be a job isn't lost behind the AI's caution.
//
// BUCKET (the single cleanest one): a raw row that is NOT yet a vacancy AND is either
//   * still 'pending' (not parsed yet), or
//   * 'skipped' with reject_reason = 'low_confidence' (the model DID think it's a job,
//     but under the confidence bar).
// Everything the parser labelled as junk (spam / spam_prefilter / currency_exchange /
// agency_promo / course_ad / chitchat / resume_seeking_job / housing / ad_non_job /
// not_vacancy / unclear / too_old / takedown, and any 'error' row) is excluded BY
// CONSTRUCTION — the WHERE is a whitelist (pending ∪ skipped+low_confidence), not a
// blacklist, so a new reject reason can never leak into this stream.
//
// SECURITY (007 — no NEW field is exposed vs the feed, but mind the caveat below):
//   * text is run through scrubContacts() — a best-effort regex scrub (e-mails, @handles,
//     "<messenger> <id>", phones, t.me·wa.me·kakao links). It is HEURISTIC, not a proof:
//     an oddly formatted contact can still slip through, so this is defense-in-depth only,
//     NOT a guarantee that no contact ever reaches the client.
//   * There is NO reveal path for raw messages: the content is UNVERIFIED, so we never
//     expose a stored contact for it (no /contact sibling, no contact field, no has_contact,
//     no employer) — structurally FEWER fields than the feed.
//   * CAVEAT — do not read this stream as "safer" than the feed on the contact axis. The raw
//     text is cleaned ONLY by that regex scrub; unlike the feed's description it did NOT pass
//     the parser (which is instructed to keep contacts out of the text). So on the
//     contact-in-free-text axis raw is scrubbed LESS thoroughly, not "strictly less".
//   * source_id / tg_chat_id / sender_id / sender_username / raw payload are NEVER
//     projected — the source does not leak out (007). source_kind is a constant 'raw'.
//
// Cursor pagination over (fetched_at, id) — fetched_at is the server-authoritative,
// NOT-NULL timestamp (posted_at from Telegram can be null), so the tuple order is stable.
// Same tma auth as the feed; no per-user scope (this is a shared "not sorted yet" pool
// behind the tma gate).

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, queryParam } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { getConfigNumber } from '../config.js';
import { scrubContacts } from '../core/scrub.js';

const PAGE_SIZE = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RawRow {
  id: string;
  text: string | null;
  posted_at: string | null;
  fetched_at: string; // ordering key + cursor anchor; NOT projected to the client
  age_days: number | null;
}

/** DB row -> the UNVERIFIED card. No source/sender/contact — strictly less than the feed. */
function toRawView(r: RawRow) {
  return {
    id: r.id,
    // Defense in depth: scrub even though nothing here is a "reveal" — the text is shown raw.
    text: scrubContacts(r.text ?? '') ?? '',
    posted_at: r.posted_at ? new Date(r.posted_at).toISOString() : null,
    // Whole days since the message (posted_at when Telegram gave it, else fetched_at). Lets
    // the card show recency even when posted_at is null. Always >= 0.
    age_hint: typeof r.age_days === 'number' ? r.age_days : null,
    status_hint: 'unverified' as const,
    source_kind: 'raw' as const,
  };
}

function encodeCursor(fetchedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ f: fetchedAt, i: id }), 'utf8').toString('base64url');
}
function decodeCursor(c: string | undefined): { f: string; i: string } | null {
  if (!c) return null;
  try {
    const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { f?: unknown; i?: unknown };
    // Validate `f` as a real timestamp: a non-timestamptz string would blow up the `::timestamptz`
    // cast in SQL and surface as a 500. A bad/forged cursor must degrade to the first page, not error.
    if (typeof o.f === 'string' && typeof o.i === 'string' && UUID_RE.test(o.i) && !Number.isNaN(Date.parse(o.f)))
      return { f: o.f, i: o.i };
  } catch {
    /* bad cursor -> first page */
  }
  return null;
}

/** GET /api/raw — cursor feed over UNVERIFIED raw messages (pending ∪ skipped+low_confidence). */
export async function rawFeed(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const cur = decodeCursor(queryParam(req, 'cursor'));

  try {
    // Freshness window (only recent unsorted messages). Clamp to >= 1 day so a mis-seeded
    // 0/negative config can never break make_interval or blank the stream unintentionally.
    const maxAge = Math.max(1, Math.floor(await getConfigNumber('raw_max_age_days', 14)));

    const sql = getSql();
    const p: unknown[] = [];
    const ph = (v: unknown): string => {
      p.push(v);
      return `$${p.length}`;
    };
    const maxAgePh = ph(maxAge);
    const noCursor = cur === null;
    const cursorClause =
      `and (${ph(noCursor)} or (fetched_at, id) < (${ph(cur?.f ?? null)}::timestamptz, ${ph(cur?.i ?? null)}::uuid))`;
    const text =
      `select id, text, posted_at, fetched_at,
              greatest(0, floor(extract(epoch from (now() - coalesce(posted_at, fetched_at))) / 86400))::int as age_days
       from raw_messages
       where vacancy_id is null
         and (status = 'pending' or (status = 'skipped' and reject_reason = 'low_confidence'))
         and fetched_at > now() - make_interval(days => ${maxAgePh})
         ${cursorClause}
       order by fetched_at desc, id desc
       limit ${PAGE_SIZE + 1}`;
    const rows = (await sql(text, p)) as unknown as RawRow[];

    const hasMore = rows.length > PAGE_SIZE;
    const kept = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const items = kept.map(toRawView);
    const last = kept[kept.length - 1];
    const next_cursor =
      hasMore && last ? encodeCursor(new Date(last.fetched_at).toISOString(), last.id) : null;

    send(res, 200, { items, next_cursor });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
