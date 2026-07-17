// lib/korea/users/onboarded.ts
//
// POST /api/onboarded — mark the caller as having completed the one-time onboarding.
// Idempotent: sets users.onboarded_at once (first call wins); a repeat call is a no-op
// and still returns 200 { onboarded: true }. User is resolved from verified initData
// (007: user_id NEVER from the request body — no body is read at all).

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';

export async function onboardedPost(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  try {
    const sql = getSql();
    // First stamp wins: only set when still NULL, so re-runs never move the timestamp.
    await sql`
      update users set onboarded_at = now()
      where id = ${auth.user.id}::uuid and onboarded_at is null`;
    send(res, 200, { onboarded: true });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
