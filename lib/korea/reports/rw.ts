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
//
// USER ADS (2026-10-21, Законник + owner). The app shows the same action on EVERY open card, and an
// open card can be a USER AD — but vacancy_reports.vacancy_id is a NOT NULL FK into `vacancies`, so
// a complaint about an ad used to answer 404 and go nowhere. It now lands in ad_reports (the ad-side
// twin, draft_0034) under the SAME rules: one per (user, ad), a per-user 24h cap, admins notified,
// nothing hidden automatically. ONE extra consequence, deliberate:
//   🔴 the FIRST complaint EXPIRES that ad's FREE featured lift (draft_0033) and leaves the AD
//      ITSELF live and visible. Withdrawing a bonus we grant by our own mechanics promises nothing
//      to anybody; taking an ad down is a human's decision. And it must be MECHANICS — never
//      somebody editing a row by hand (that is the whole reason this line exists).
// The two kinds keep SEPARATE daily budgets on purpose: making the long-standing vacancy path count
// a table that may not exist yet (deploy before migrate) would turn a missing migration into a 500
// on every vacancy report.

import { getSql } from '../core/db.js';
import { revokeFeaturedOnReport } from '../ads/featured.js';
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

/**
 * DM the admins about a NEW complaint on a USER AD. No inline buttons: the [Скрыть]/[Оставить]
 * callbacks (bot/webhook.ts) act on a VACANCY id, and wiring a second pair for ads is a separate
 * decision — so this message says plainly what already happened automatically (the lift is gone)
 * and what did not (the ad is still live). Scrubbed + capped snippet, no contacts, best-effort.
 */
async function notifyAdminsAdReport(
  sql: ReturnType<typeof getSql>,
  ad: VacInfo,
  reason: string | null,
  count: number,
  liftRemoved: boolean,
): Promise<void> {
  const ids = await adminRecipients(sql);
  if (ids.length === 0) return;

  const city = ad.city_name?.ru ?? '—';
  const base = ad.title && ad.title.trim() ? ad.title : (ad.description ?? '');
  const snippet = (scrubContacts(base) ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '—';
  const reasonText = reason && reason.trim() ? reason.trim().slice(0, 200) : '—';
  const summary =
    `Жалоба на объявление (размещено через форму): ${city} · ${workTypeLabelRu(ad.work_type)} · ${snippet} · ` +
    `причина: ${reasonText} · всего жалоб: ${count}\n` +
    (liftRemoved
      ? 'Подъём в верх ленты снят автоматически. Само объявление осталось в ленте — решение по нему за тобой.'
      : 'Объявление осталось в ленте — решение по нему за тобой.');

  for (const id of ids) {
    try {
      await sendMessage(id, summary);
    } catch {
      // eslint-disable-next-line no-console
      console.error('[reports] admin notify failed');
    }
  }
}

/**
 * The USER AD branch of POST /api/vacancies/:id/report. Returns false when the id is not an ad
 * either (the caller then answers 404) and true when the request has been fully answered.
 */
async function reportUserAd(
  sql: ReturnType<typeof getSql>,
  res: ResLike,
  userId: string,
  adId: string,
  reason: string | null,
): Promise<boolean> {
  const adRows = (await sql`
    select a.title, a.description, a.work_type, c.name as city_name
    from user_ads a left join cities c on c.id = a.city_id
    where a.id = ${adId}::uuid limit 1`) as unknown as VacInfo[];
  const ad = adRows[0];
  if (!ad) return false;

  const already = await sql`
    select 1 from ad_reports where user_id = ${userId}::uuid and user_ad_id = ${adId}::uuid limit 1`;
  if (already.length === 0) {
    const cap = await getConfigNumber('report_daily_cap', 20);
    const cnt = await sql`
      select count(*)::int as c from ad_reports
      where user_id = ${userId}::uuid and created_at > now() - interval '24 hours'`;
    if (((cnt[0]?.c as number | undefined) ?? 0) >= cap) {
      sendError(res, ApiErrorCode.RateLimited);
      return true;
    }
    const ins = await sql`
      insert into ad_reports (user_id, user_ad_id, reason)
      values (${userId}::uuid, ${adId}::uuid, ${reason})
      on conflict (user_id, user_ad_id) do nothing
      returning 1`;

    if (ins.length > 0) {
      // 🔴 FIRST COMPLAINT TAKES THE LIFT, NOT THE AD (Законник 2026-10-21). Nothing about the ad's
      // status, visibility or expiry is touched here — only its free top-of-feed week ends.
      const liftRemoved = await revokeFeaturedOnReport(sql, adId);
      const totalRows = (await sql`
        select count(*)::int as c from ad_reports where user_ad_id = ${adId}::uuid`) as unknown as {
        c: number;
      }[];
      await notifyAdminsAdReport(sql, ad, reason, totalRows[0]?.c ?? 1, liftRemoved);
    }
  }

  send(res, 200, { ok: true });
  return true;
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
    if (!vac) {
      // Not a scraped vacancy — the same card id may be a USER AD (the app shows this action on
      // every open card). Answered there, 404 only if it is neither.
      if (await reportUserAd(sql, res, auth.user.id, id, reason)) return;
      return sendError(res, ApiErrorCode.NotFound);
    }

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
