// lib/korea/vacancies/moderate.ts
//
// POST /api/vacancies/:id/takedown — ADMIN. Bot Developer ToS 5.2(i) / 007 CRIT:
// deactivate a vacancy that must not be shown (e.g. a third party's contact published
// without consent) AND record its content_hash in `takedowns` so the same dedup key is
// never re-inserted by the parser (or resurrected by a repost). Idempotent.
//
// Admin proof: Bearer CRON_SECRET OR an ADMIN_TELEGRAM_IDS user (see admin/auth.ts).

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, readJsonBody, queryParam } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { requireAdmin } from '../admin/auth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LEN = 500;

interface Body {
  reason?: unknown;
}

export async function vacancyTakedown(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  const admin = await requireAdmin(req);
  if (!admin.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const id = queryParam(req, 'id');
  if (!id || !UUID_RE.test(id)) return sendError(res, ApiErrorCode.NotFound);

  const body = (await readJsonBody(req)) as Body | null;
  const reason = typeof body?.reason === 'string' ? body.reason.slice(0, MAX_REASON_LEN) : null;

  try {
    const sql = getSql();

    // Read the EXISTING generated content_hash straight off the row (no recompute).
    const rows = (await sql`
      select content_hash, contact_normalized, source_id, raw_message_id
      from vacancies where id = ${id}::uuid limit 1`) as unknown as {
      content_hash: string;
      contact_normalized: string | null;
      source_id: string | null;
      raw_message_id: string | null;
    }[];
    const v = rows[0];
    if (!v) return sendError(res, ApiErrorCode.NotFound);

    await sql`update vacancies set is_active = false where id = ${id}::uuid`;
    // Idempotent: one takedown record per content_hash (re-running on an already
    // taken-down vacancy must not duplicate the audit row).
    await sql`
      insert into takedowns (content_hash, contact_normalized, source_id, raw_message_id, reason)
      select ${v.content_hash}, ${v.contact_normalized}, ${v.source_id}::uuid, ${v.raw_message_id}::uuid, ${reason}
      where not exists (select 1 from takedowns where content_hash = ${v.content_hash})`;

    send(res, 200, { ok: true });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
