// lib/korea/ingest/handler.ts
//
// The collector's ONLY way into the database. Two endpoints, both authenticated by
// a shared bearer secret (INGEST_SECRET) — NOT initData:
//
//   GET  /api/sources  -> active sources the reader should sit in
//   POST /api/ingest   -> INSERT-only into raw_messages (idempotent)
//
// This is the whole reason the collector host never holds DATABASE_URL (007: secret
// isolation by host). A compromised collector can at most push spam into
// raw_messages, which the AI + dedup filter.
//
// All queries use the Neon tagged template: ${values} are BOUND parameters, never
// interpolated — parameterized by default (007 requirement). bigint/uuid/timestamptz
// params are cast explicitly so a text-bound value lands in the right column type.
//
// ── TWO BODY SHAPES, ONE CODE PATH (2026-08-29, after the compute outage) ────────────────────
// POST /api/ingest accepts either
//   * ONE message   { tg_chat_id, tg_message_id, text, ... }   -> { ok, inserted: boolean }
//   * A BATCH       { messages: [ {...}, {...} ] }             -> { ok, inserted: number, ... }
// The batch is what the reader normally sends now: a Neon compute only sleeps after 5 minutes of
// silence, so one request per message meant the database never slept at all (110 of 100 CU-hours
// burned by Aug 19; the product was down for everybody until the billing period reset). One
// request per quarter-hour window costs one wake-up instead of dozens.
//
// The single-message form is NOT deprecated: the reader and this backend live on different hosts
// and are deployed separately, so the older shape must keep working — and the reader falls back
// to it when a batch comes back 400/404. Both shapes run through the SAME resolve+insert code
// (ingestMessages), so they cannot drift apart in what they accept or record.
//
// The two answers are told apart by the TYPE of `inserted` (boolean for one message, number for a
// batch); that is what lets the reader recognise an old backend instead of reading a refusal as
// success.

import { getSql } from '../core/db.js';
import {
  type ReqLike,
  type ResLike,
  send,
  sendError,
  readJsonBody,
  bearerToken,
  constantTimeEquals,
} from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';

/** Hard cap on stored text — anti-poisoning + storage guard. */
const MAX_TEXT_LEN = 8_000;

/**
 * Hard cap on messages in ONE batch request. Above it the answer is 413 (the BODY is too big),
 * which tells the reader to split the batch in half and send both halves — unlike 400, which
 * would tell it the messages themselves are bad. The reader clamps its own batch size to this
 * same number, so in practice this guards against a broken/hostile client, not the normal path.
 */
export const MAX_BATCH_ITEMS = 200;

function authorized(req: ReqLike): boolean {
  return constantTimeEquals(bearerToken(req), process.env.INGEST_SECRET);
}

function unauthorized(res: ResLike): void {
  res.statusCode = 401;
  res.end('');
}

/** GET /api/sources — active sources (bearer INGEST_SECRET). */
export async function sourcesGet(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);
  if (!authorized(req)) return unauthorized(res);

  try {
    const sql = getSql();
    const rows = await sql`
      select tg_chat_id, username, is_active
      from sources
      where is_active = true`;
    const sources = rows.map((r) => ({
      tg_chat_id: r.tg_chat_id != null ? String(r.tg_chat_id) : null,
      username: r.username ?? null,
      is_active: r.is_active,
    }));
    send(res, 200, { sources });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}

interface IngestBody {
  tg_chat_id?: string | number;
  username?: string;
  tg_message_id?: number;
  sender_id?: string | null;
  sender_username?: string | null;
  text?: string;
  posted_at?: string;
}

/** One message after validation — every field already in the shape the INSERT wants. */
export interface CleanMessage {
  chatId: string;
  username: string | null;
  messageId: number;
  senderId: string | null;
  senderUsername: string | null;
  text: string;
  postedAt: string;
}

/** What ingestMessages did, in counts. Both response shapes are built from this. */
interface IngestCounts {
  /** Messages in the request. */
  received: number;
  /** Rows actually written (a duplicate re-delivery counts 0 — ON CONFLICT DO NOTHING). */
  inserted: number;
  /** Messages from a chat we do not collect, or whose source is switched off. */
  unknownSource: number;
  /** Entries that were not a usable message at all (missing/odd ids or text). */
  invalid: number;
}

/**
 * A Telegram id in the form the database wants: a plain integer in a string, bindable to a
 * ::bigint parameter. Anything else is rejected rather than passed through — ONE unparsable id
 * inside a batch would otherwise make the whole INSERT throw and cost the other 199 messages.
 */
function bigintText(v: unknown): string | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? String(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^-?\d{1,19}$/.test(s) ? s : null;
}

// ── EVERY field of the multi-row INSERT is checked, not just the identifiers ─────────────────
// In a one-row INSERT a bad value costs one message. In a 200-row INSERT it costs 200: Postgres
// rejects the whole statement. So the rule is not "validate ids", it is "validate every column
// that a bound parameter reaches" — the class, not the instance that bit us first.

/** C0 controls EXCEPT tab and newline, plus DEL. A NUL byte alone makes Postgres reject the
 *  entire statement ("invalid byte sequence"), taking the batch with it. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** Half of a surrogate pair with nothing on the other side: not encodable as UTF-8, so the
 *  driver or the server rejects the whole request. Telegram text can carry one after a client
 *  bug, and SLICING at a character limit can create one out of a perfectly good emoji. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Telegram @handles: latin letters, digits, underscore, at most 32. Anything else is not a
 *  handle — and this string is shown to people as a CONTACT, so it may not be arbitrary text. */
const HANDLE_RE = /^[A-Za-z0-9_]{1,32}$/;
/** Nothing on Telegram was posted before Telegram existed; earlier means a broken clock. */
const EARLIEST_POSTED_AT = Date.UTC(2013, 0, 1);
/** Tolerated clock skew on the reader host. Beyond it, a "future" post would sit at the top of
 *  the feed forever and never age out of the freshness window. */
const FUTURE_SLACK_MS = 60 * 60 * 1000;

/** Message text as it may be stored: no control bytes, no broken UTF-16, clipped — and the clip
 *  itself cannot leave a broken pair behind. */
export function cleanText(raw: string): string {
  const normalized = raw
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(LONE_SURROGATE, '');
  return normalized.slice(0, MAX_TEXT_LEN).replace(LONE_SURROGATE, '');
}

/** A usable @handle, or null. Never throws, never passes arbitrary text through. */
export function cleanHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const h = raw.trim().replace(/^@+/, '');
  return HANDLE_RE.test(h) ? h : null;
}

/**
 * A timestamptz we are willing to bind. An absent, unparsable, ancient or far-future value falls
 * back to NOW rather than rejecting the message: the posting is real even when its clock is not,
 * and a bogus date would poison the freshness window and the retention sweep instead.
 */
export function cleanPostedAt(raw: unknown, now: number = Date.now()): string {
  if (typeof raw === 'string' && raw.length > 0) {
    const t = Date.parse(raw);
    if (Number.isFinite(t) && t >= EARLIEST_POSTED_AT && t <= now + FUTURE_SLACK_MS) {
      return new Date(t).toISOString();
    }
  }
  return new Date(now).toISOString();
}

/** Validate + normalize one incoming message. Returns null when it is not usable. */
export function cleanMessage(raw: unknown): CleanMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as IngestBody;
  const chatId = bigintText(body.tg_chat_id);
  if (chatId === null) return null;
  if (typeof body.tg_message_id !== 'number' || !Number.isSafeInteger(body.tg_message_id)) return null;
  if (typeof body.text !== 'string') return null;

  const text = cleanText(body.text);
  // Nothing left after cleaning = there was no message here, only control bytes.
  if (text.trim().length === 0) return null;

  return {
    chatId,
    // The source @username used for resolution — same character rules as any other handle.
    username: cleanHandle(body.username),
    messageId: body.tg_message_id,
    // A sender id we cannot parse becomes "unknown" instead of poisoning the statement: WHO sent
    // it is a nice-to-have, the message itself is the point.
    senderId: bigintText(body.sender_id),
    // The AUTHOR handle. It becomes the card contact when the text has none (parser/run.ts), so
    // it is validated as a handle and not merely stored.
    senderUsername: cleanHandle(body.sender_username),
    text,
    postedAt: cleanPostedAt(body.posted_at),
  };
}

interface SourceRow {
  id: string;
  is_active: boolean;
}

/**
 * Resolve, backfill and INSERT — the one path both body shapes go through.
 *
 * The COST SHAPE is the point: this used to be 2..4 queries PER MESSAGE. It is now
 *   1 lookup for the whole batch  +  a rare backfill UPDATE  +  1 multi-row INSERT,
 * which is what lets a whole 15-minute window fit inside a single database wake-up.
 */
async function ingestMessages(items: CleanMessage[]): Promise<IngestCounts> {
  const counts: IngestCounts = { received: items.length, inserted: 0, unknownSource: 0, invalid: 0 };
  if (items.length === 0) return counts;

  const sql = getSql();

  const chatIds = [...new Set(items.map((m) => m.chatId))];
  const usernames = [
    ...new Set(items.map((m) => m.username?.toLowerCase()).filter((u): u is string => !!u)),
  ];

  // ONE lookup for every source the batch mentions — by chat id, or by @username for a source
  // whose id has not been backfilled yet. Both arrays are BOUND, never interpolated.
  const rows = (await sql`
    select id, tg_chat_id, username, is_active
    from sources
    where tg_chat_id = any(${chatIds}::bigint[])
       or (tg_chat_id is null and lower(username) = any(${usernames}::text[]))`) as unknown as {
    id: string;
    tg_chat_id: string | number | null;
    username: string | null;
    is_active: boolean;
  }[];

  const byChatId = new Map<string, SourceRow>();
  const byUnboundName = new Map<string, SourceRow>();
  for (const r of rows) {
    const source: SourceRow = { id: String(r.id), is_active: r.is_active };
    if (r.tg_chat_id != null) byChatId.set(String(r.tg_chat_id), source);
    else if (r.username) byUnboundName.set(r.username.toLowerCase(), source);
  }

  // Rows to write, de-duplicated on the SAME key the database's unique index uses, so a message
  // repeated inside one batch cannot become two speculative inserts.
  const toInsert: { source: SourceRow; msg: CleanMessage }[] = [];
  const seen = new Set<string>();

  for (const msg of items) {
    let source = byChatId.get(msg.chatId) ?? null;

    if (!source && msg.username) {
      // Telegram usernames are case-insensitive; the seed may store a different case. This path
      // runs only until tg_chat_id is backfilled (first message) — after which resolution goes
      // through the fast chat-id branch, including for the rest of THIS batch.
      const key = msg.username.toLowerCase();
      const byName = byUnboundName.get(key);
      if (byName) {
        source = byName;
        await sql`update sources set tg_chat_id = ${msg.chatId}::bigint where id = ${byName.id}::uuid`;
        byChatId.set(msg.chatId, byName);
        byUnboundName.delete(key);
      }
    }

    // Accept-and-ignore: the reader may be slightly ahead of source approvals.
    if (!source || !source.is_active) {
      counts.unknownSource += 1;
      continue;
    }

    const key = `${source.id}:${msg.messageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    toInsert.push({ source, msg });
  }

  if (toInsert.length === 0) return counts;

  // ONE multi-row INSERT. Placeholders are generated from the row INDEX (never from data), and
  // every value is a bound parameter with an explicit cast — the same casts the single-row
  // statement used, so a text-bound value still lands in the right column type.
  const cols = 7;
  const tuples = toInsert
    .map((_, i) => {
      const b = i * cols;
      return `($${b + 1}::uuid, $${b + 2}::bigint, $${b + 3}::bigint, $${b + 4}::bigint, $${b + 5}::text, $${b + 6}::text, $${b + 7}::timestamptz)`;
    })
    .join(', ');
  const params: unknown[] = [];
  for (const { source, msg } of toInsert) {
    params.push(
      source.id,
      msg.messageId,
      msg.chatId,
      msg.senderId,
      msg.senderUsername,
      msg.text,
      msg.postedAt,
    );
  }

  const insertedRows = await sql(
    `insert into raw_messages
       (source_id, tg_message_id, tg_chat_id, sender_id, sender_username, text, posted_at)
     values ${tuples}
     on conflict (source_id, tg_message_id) do nothing
     returning id`,
    params,
  );
  counts.inserted = insertedRows.length;
  return counts;
}

/** POST /api/ingest — INSERT raw messages (bearer INGEST_SECRET), idempotent. */
export async function ingestPost(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  if (!authorized(req)) return unauthorized(res);

  const body = (await readJsonBody(req)) as (IngestBody & { messages?: unknown }) | null;
  if (!body || typeof body !== 'object') {
    return sendError(res, ApiErrorCode.BadRequest, 'missing tg_chat_id / tg_message_id / text');
  }

  // ── BATCH ─────────────────────────────────────────────────────────────────────────────────
  if (Array.isArray(body.messages)) {
    const raw = body.messages;
    if (raw.length > MAX_BATCH_ITEMS) {
      // 413, not 400: the reader answers this by halving the batch and sending both halves.
      return sendError(res, ApiErrorCode.PayloadTooLarge, 'batch_too_large');
    }
    const items: CleanMessage[] = [];
    let invalid = 0;
    for (const one of raw) {
      const clean = cleanMessage(one);
      if (clean) items.push(clean);
      else invalid += 1;
    }
    // One bad entry must not cost the other 199: unusable entries are COUNTED, not fatal.
    try {
      const counts = await ingestMessages(items);
      counts.received = raw.length;
      counts.invalid = invalid;
      if (invalid > 0 || counts.unknownSource > 0) {
        // Counts only — never the text or the sender (007). A batch quietly dropping most of its
        // content has to be visible in the log, not only in the reply nobody reads.
        // eslint-disable-next-line no-console
        console.log(
          `[ingest] batch received=${counts.received} inserted=${counts.inserted} unknown_source=${counts.unknownSource} invalid=${invalid}`,
        );
      }
      return send(res, 200, { ok: true, ...counts });
    } catch (err) {
      return sendError(res, ApiErrorCode.Internal, 'ingest_batch', err);
    }
  }

  // ── ONE MESSAGE (the older shape; still first-class) ───────────────────────────────────────
  const clean = cleanMessage(body);
  if (!clean) {
    return sendError(res, ApiErrorCode.BadRequest, 'missing tg_chat_id / tg_message_id / text');
  }
  try {
    const counts = await ingestMessages([clean]);
    if (counts.unknownSource > 0) {
      return send(res, 200, { ok: true, inserted: false, reason: 'unknown_source' });
    }
    // `inserted` stays a BOOLEAN here — its type is how the reader tells this answer from a batch
    // answer, so it must not be "made consistent" into a number.
    return send(res, 200, { ok: true, inserted: counts.inserted > 0 });
  } catch {
    return sendError(res, ApiErrorCode.Internal);
  }
}
