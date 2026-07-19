// lib/korea/reports/rw.ts
//
// POST /api/vacancies/:id/report — a user flags a vacancy (spam / scam / stale / wrong
// contact). UNIQUE(user_id, vacancy_id) means a repeat report is a no-op success. A
// per-user daily cap (mirrors contact_reveals) blocks report-spam. User resolved from
// verified initData (007: never from the body).
//
// On a NEW report the configured admins get a DM with [Скрыть]/[Оставить] inline buttons
// (handled in bot/webhook.ts). Owner rule: reports only NOTIFY — nothing is hidden
// automatically. The DM send is best-effort: a failure never breaks the POST.

import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, readJsonBody, queryParam } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { getConfigNumber } from '../config.js';
import { sendMessage } from '../bot/telegram.js';
import { adminRecipients } from '../admin/auth.js';
import { scrubContacts } from '../core/scrub.js';
import { workTypeLabelRu } from '../core/labels.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LEN = 500;

interface Body {
  reason?: unknown;
}

interface VacInfo {
  title: string | null;
  description: string | null;
  work_type: string;
  city_name: { ru: string; ko: string; en: string } | null;
}

/**
 * DM the configured admins about a NEW report with [Скрыть]/[Оставить] buttons. The snippet is
 * scrubbed of contacts and capped, so no PII (contacts) reaches the DM or a log. Best-effort:
 * any send failure is swallowed (the POST must still succeed).
 */
async function notifyAdminsReport(
  sql: ReturnType<typeof getSql>,
  vacancyId: string,
  vac: VacInfo,
  reason: string | null,
  count: number,
): Promise<void> {
  const ids = await adminRecipients(sql);
  if (ids.length === 0) return;

  const city = vac.city_name?.ru ?? '—';
  const base = vac.title && vac.title.trim() ? vac.title : (vac.description ?? '');
  const snippet = (scrubContacts(base) ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '—';
  const reasonText = reason && reason.trim() ? reason.trim().slice(0, 200) : '—';
  const summary =
    `Жалоба на вакансию: ${city} · ${workTypeLabelRu(vac.work_type)} · ${snippet} · ` +
    `причина: ${reasonText} · всего жалоб: ${count}`;

  const extra = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Скрыть', callback_data: `rep:hide:${vacancyId}` },
          { text: 'Оставить', callback_data: `rep:keep:${vacancyId}` },
        ],
      ],
    },
  };
  for (const id of ids) {
    try {
      await sendMessage(id, summary, extra);
    } catch {
      // eslint-disable-next-line no-console
      console.error('[reports] admin notify failed');
    }
  }
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

    // The vacancy must exist (any state) — reject a random uuid. Pull the fields the admin DM needs.
    const vacRows = (await sql`
      select v.title, v.description, v.work_type, c.name as city_name
      from vacancies v left join cities c on c.id = v.city_id
      where v.id = ${id}::uuid limit 1`) as unknown as VacInfo[];
    const vac = vacRows[0];
    if (!vac) return sendError(res, ApiErrorCode.NotFound);

    // A repeat report of the same vacancy is free (recorded once). A NEW one counts against
    // the per-user 24h cap AND notifies the admins.
    const already = await sql`
      select 1 from vacancy_reports where user_id = ${auth.user.id}::uuid and vacancy_id = ${id}::uuid limit 1`;
    if (already.length === 0) {
      const cap = await getConfigNumber('report_daily_cap', 20);
      const cnt = await sql`
        select count(*)::int as c from vacancy_reports
        where user_id = ${auth.user.id}::uuid and created_at > now() - interval '24 hours'`;
      if (((cnt[0]?.c as number | undefined) ?? 0) >= cap) return sendError(res, ApiErrorCode.RateLimited);
      const ins = await sql`
        insert into vacancy_reports (user_id, vacancy_id, reason)
        values (${auth.user.id}::uuid, ${id}::uuid, ${reason})
        on conflict (user_id, vacancy_id) do nothing
        returning 1`;

      // Only on a genuine INSERT (not a race that hit the conflict): notify admins with the
      // running total for this vacancy. Best-effort — a DM failure must not break the report.
      if (ins.length > 0) {
        const totalRows = (await sql`
          select count(*)::int as c from vacancy_reports where vacancy_id = ${id}::uuid`) as unknown as {
          c: number;
        }[];
        await notifyAdminsReport(sql, id, vac, reason, totalRows[0]?.c ?? 1);
      }
    }

    send(res, 200, { ok: true });
  } catch {
    sendError(res, ApiErrorCode.Internal);
  }
}
