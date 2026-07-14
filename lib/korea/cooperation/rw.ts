// lib/korea/cooperation/rw.ts
//
// POST /api/cooperation — "Сотрудничество" enquiry. STUB: we only persist the request
// (cooperation_requests) for audit; no email is sent yet. Auth via initData; user id
// from the verified identity, contact/message from the body (treated as data).

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, readJsonBody } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';

const MAX_CONTACT_LEN = 200;
const MAX_MESSAGE_LEN = 2_000;

interface Body {
  contact?: unknown;
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
  const contact = str(body?.contact, MAX_CONTACT_LEN);
  const message = str(body?.message, MAX_MESSAGE_LEN);
  if (!contact && !message) return sendError(res, ApiErrorCode.BadRequest, 'empty request');

  try {
    const sql = getSql();
    await sql`
      insert into cooperation_requests (user_id, contact, message)
      values (${auth.user.id}::uuid, ${contact}, ${message})`;
    send(res, 200, { ok: true });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
