// lib/korea/terms/rw.ts
//
// POST /api/terms/accept — record that the caller accepted the current terms of use.
// Consent is stored SERVER-SIDE on the user row (Susanin/007 brief: CloudStorage is
// not suitable for legally-meaningful consent). User resolved from verified initData.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { getConfigString } from '../config.js';

export async function termsAccept(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  try {
    const version = await getConfigString('terms_version', 'unversioned');
    const sql = getSql();
    await sql`
      update users set terms_accepted_at = now(), terms_version = ${version}
      where id = ${auth.user.id}::uuid`;
    send(res, 200, { ok: true, version });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
