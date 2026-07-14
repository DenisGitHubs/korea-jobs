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

/** POST /api/ingest — INSERT one raw message (bearer INGEST_SECRET), idempotent. */
export async function ingestPost(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  if (!authorized(req)) return unauthorized(res);

  const body = (await readJsonBody(req)) as IngestBody | null;
  if (
    !body ||
    body.tg_chat_id == null ||
    typeof body.tg_message_id !== 'number' ||
    typeof body.text !== 'string'
  ) {
    return sendError(res, ApiErrorCode.BadRequest, 'missing tg_chat_id / tg_message_id / text');
  }

  const chatId = String(body.tg_chat_id);
  const text = body.text.slice(0, MAX_TEXT_LEN);

  try {
    const sql = getSql();

    // Resolve the source by chat id; else by @username (and backfill the chat id so a
    // source added by username before its id was known auto-resolves on first message).
    let source: { id: string; is_active: boolean } | null = null;

    const byId = await sql`
      select id, is_active from sources where tg_chat_id = ${chatId}::bigint limit 1`;
    if (byId[0]) source = byId[0] as { id: string; is_active: boolean };

    if (!source && body.username) {
      const byName = await sql`
        select id, is_active from sources
        where tg_chat_id is null and username = ${body.username} limit 1`;
      if (byName[0]) {
        source = byName[0] as { id: string; is_active: boolean };
        await sql`update sources set tg_chat_id = ${chatId}::bigint where id = ${source.id}::uuid`;
      }
    }

    if (!source || !source.is_active) {
      // Accept-and-ignore: the reader may be slightly ahead of source approvals.
      return send(res, 200, { ok: true, inserted: false, reason: 'unknown_source' });
    }

    const inserted = await sql`
      insert into raw_messages
        (source_id, tg_message_id, tg_chat_id, sender_id, sender_username, text, posted_at)
      values
        (${source.id}::uuid, ${body.tg_message_id}, ${chatId}::bigint,
         ${body.sender_id ?? null}::bigint, ${body.sender_username ?? null},
         ${text}, ${body.posted_at ?? new Date().toISOString()}::timestamptz)
      on conflict (source_id, tg_message_id) do nothing
      returning id`;

    send(res, 200, { ok: true, inserted: inserted.length > 0 });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
