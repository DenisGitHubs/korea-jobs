// lib/korea/cooperation/rw.ts
//
// POST /api/cooperation — "Сотрудничество" enquiry. STUB: we only persist the request
// (cooperation_requests) for audit; no email is sent yet. Auth via initData. The CONTACT
// is the requester's OWN Telegram account, derived from the verified identity — the app
// already knows who is asking, so the form no longer asks the user to type it in.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, readJsonBody } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';

const MAX_MESSAGE_LEN = 2_000;

interface Body {
  message?: unknown;
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

export async function cooperationPost(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const body = (await readJsonBody(req)) as Body | null;
  const message = str(body?.message, MAX_MESSAGE_LEN);
  if (!message) return sendError(res, ApiErrorCode.BadRequest, 'message is required');

  try {
    const sql = getSql();
    // Contact = the requester's own Telegram handle from the verified identity (never a
    // user-typed field). Prefer @username; fall back to a tg:// deep link by id so the
    // owner can always reach whoever sent the enquiry, even without a public username.
    const urows = (await sql`
      select username, telegram_id from users where id = ${auth.user.id}::uuid limit 1`) as unknown as {
      username: string | null;
      telegram_id: string | number | null;
    }[];
    const uname = urows[0]?.username ?? null;
    const tgid = urows[0]?.telegram_id ?? null;
    const contact = uname ? '@' + uname : tgid != null ? 'tg://user?id=' + tgid : null;

    await sql`
      insert into cooperation_requests (user_id, contact, message)
      values (${auth.user.id}::uuid, ${contact}, ${message})`;
    send(res, 200, { ok: true });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
