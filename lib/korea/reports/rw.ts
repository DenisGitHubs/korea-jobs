// lib/korea/reports/rw.ts
//
// POST /api/vacancies/:id/report — a user flags a vacancy (spam / scam / stale / wrong
// contact). UNIQUE(user_id, vacancy_id) means a repeat report is a no-op success. A
// per-user daily cap (mirrors contact_reveals) blocks report-spam. User resolved from
// verified initData (007: never from the body).

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, readJsonBody, queryParam } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { getConfigNumber } from '../config.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LEN = 500;

interface Body {
  reason?: unknown;
}

export async function vacancyReport(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const id = queryParam(req, 'id');
  if (!id || !UUID_RE.test(id)) return sendError(res, ApiErrorCode.NotFound);

  const body = (await readJsonBody(req)) as Body | null;
  const reason = typeof body?.reason === 'string' ? body.reason.slice(0, MAX_REASON_LEN) : null;

  try {
    const sql = getSql();

    // The vacancy must exist (any state) — reject a random uuid.
    const vac = await sql`select 1 from vacancies where id = ${id}::uuid limit 1`;
    if (vac.length === 0) return sendError(res, ApiErrorCode.NotFound);

    // A repeat report of the same vacancy is free (recorded once). A NEW one counts
    // against the per-user 24h cap.
    const already = await sql`
      select 1 from vacancy_reports where user_id = ${auth.user.id}::uuid and vacancy_id = ${id}::uuid limit 1`;
    if (already.length === 0) {
      const cap = await getConfigNumber('report_daily_cap', 20);
      const cnt = await sql`
        select count(*)::int as c from vacancy_reports
        where user_id = ${auth.user.id}::uuid and created_at > now() - interval '24 hours'`;
      if (((cnt[0]?.c as number | undefined) ?? 0) >= cap) return sendError(res, ApiErrorCode.RateLimited);
      await sql`
        insert into vacancy_reports (user_id, vacancy_id, reason)
        values (${auth.user.id}::uuid, ${id}::uuid, ${reason})
        on conflict (user_id, vacancy_id) do nothing`;
    }

    send(res, 200, { ok: true });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
