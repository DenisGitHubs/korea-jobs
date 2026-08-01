// lib/korea/media/read.ts
//
// GET /api/media/:id — the image of a published card, served from our OWN origin.
//
// WHY IT HAS NO AUTH (and why that is safe)
// The mini app renders it with a plain <img src="/api/media/<uuid>">, and an <img> tag sends no
// Authorization header — an authenticated endpoint simply could not be used here. Two properties
// carry the security instead:
//   1. the id is an unguessable uuid (gen_random_uuid), and it is only ever handed out inside an
//      authenticated feed/detail response;
//   2. VISIBILITY IS RE-CHECKED ON EVERY REQUEST: bytes are returned ONLY while the image is
//      attached to a card the app would show anyway (user_ads.status='approved' and not expired).
//      The moment a card is archived, taken down, rejected or expires, its picture answers 404 —
//      a link that leaked earlier stops working, exactly like the card itself.
// Anything else is a 404: we never distinguish "no such id" from "not visible any more".
//
// WHAT WE NEVER DO: redirect to api.telegram.org/file/bot<TOKEN>/… . That URL contains the bot
// token; the bytes are copied into our database precisely so no client ever sees it.
//
// CACHING: the body of a given id can never change (bytes are content-addressed by sha256 and a
// row is never rewritten), so it is safe to cache immutably for a year. A card going invisible is
// not a cache problem — the browser only re-uses what it already fetched.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, sendError, sendBytes, queryParam } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { ALLOWED_MIME } from './store.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A year, immutable — the bytes behind one id never change. */
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';

interface MediaRow {
  mime: string;
  hex: string;
}

/** GET /api/media/:id — image bytes, or 404. */
export async function mediaGet(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return sendError(res, ApiErrorCode.NotFound);

  const id = queryParam(req, 'id');
  if (!id || !UUID_RE.test(id)) return sendError(res, ApiErrorCode.NotFound);

  try {
    const sql = getSql();
    // The EXISTS clause is the whole access control: bytes exist for the client only as long as a
    // visible card carries them (same predicate the feed uses for a user ad).
    const rows = (await sql`
      select m.mime, encode(m.bytes, 'hex') as hex
      from media_files m
      where m.id = ${id}::uuid
        and exists (
          select 1 from user_ads a
          where a.media_id = m.id
            and a.status = 'approved'
            and (a.expires_at is null or a.expires_at > now())
        )
      limit 1`) as unknown as MediaRow[];

    const row = rows[0];
    if (!row || typeof row.hex !== 'string' || row.hex.length === 0) {
      return sendError(res, ApiErrorCode.NotFound);
    }
    // Serve only from the whitelist, whatever the row says: the content-type we emit must be one
    // we chose, so a bad row can never turn into an active content type in the browser.
    if (!ALLOWED_MIME.has(row.mime)) return sendError(res, ApiErrorCode.NotFound);

    return sendBytes(res, 200, row.mime, Buffer.from(row.hex, 'hex'), MEDIA_CACHE_CONTROL);
  } catch (err) {
    sendError(res, ApiErrorCode.Internal, 'media_read_failed', err);
  }
}
