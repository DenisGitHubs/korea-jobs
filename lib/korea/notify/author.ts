// lib/korea/notify/author.ts
//
// Author-facing DM about the FATE of a user_ad (owner rule, 2026-07-23): tell the person who
// placed the ad what happened to it — published (with an "Открыть" deep link to the live card),
// rejected (with a human-readable reason), or routed to MANUAL review (an apology for the delay).
// A notice fires ONLY on a REAL status transition: a re-edit that lands on the SAME status must
// not re-spam the author (see the prevStatus gate on notifyAuthorAdDecision).
//
// This centralises the notice for EVERY place an ad's status becomes approved/rejected:
//   • adsCreate            — the AI auto-decision at create time
//   • adPatch / adUnarchive — re-moderation on edit / unarchive
//   • moderateAd           — the admin's manual approve/reject (bot buttons + API)
//
// Best-effort by contract: a lookup or DM failure NEVER throws (the ad row is already
// committed, and the webhook/API must still answer). Only a reachable author is messaged —
// allows_write_to_pm AND not is_blocked, the same gate the notify worker uses. Contacts are
// never touched here: we only forward the status + a reason phrase, never the ad's contact_raw.

import { getSql } from '../core/db.js';
import { sendMessage } from '../bot/telegram.js';

type Sql = ReturnType<typeof getSql>;

/** Deep link that opens the mini app directly on this ad's card (same trick as notify/run.ts). */
function feedUrl(appUrl: string, id: string): string {
  return `${appUrl.replace(/\/+$/, '')}/feed/${id}`;
}

/**
 * Human Russian phrase for a stored reject_reason. Maps the moderation enum (parser
 * REJECT_REASONS + the deterministic 'ads' backstop + the admin-manual tags). An admin's own
 * FREE-TEXT reason (not a known code, not a service token, non-blank) is returned VERBATIM — the
 * same string MyAdsTab shows the author. null / blank / service tokens → a general line.
 */
export function rejectReasonText(reason: string | null): string {
  switch (reason) {
    case 'ads':
    case 'agency_promo':
    case 'ad_non_job':
      return 'Похоже на рекламу, а не на конкретную вакансию.';
    case 'course_ad':
      return 'Похоже на рекламу курсов, а не на вакансию.';
    case 'spam':
      return 'Текст похож на спам.';
    case 'housing':
      return 'Объявление про жильё, а не про работу.';
    case 'currency_exchange':
      return 'Объявление про обмен валюты, а не про работу.';
    case 'resume_seeking_job':
      return 'Похоже на резюме (поиск работы), а не на предложение вакансии.';
    case 'too_short':
      return 'Слишком короткое описание — добавь подробностей о работе.';
    case 'no_contact':
      return 'Не указан контакт для связи.';
    case 'policy':
      return 'Объявление нарушает правила площадки.';
    case 'chitchat':
    case 'unclear':
    case 'not_vacancy':
      return 'Не удалось распознать здесь вакансию.';
    default:
      break;
  }
  // An admin may reject with a FREE-TEXT reason (POST /api/ads/:id/moderate body.reason, ≤500
  // chars); MyAdsTab shows that reason to the author verbatim, so mirror it here instead of
  // flattening it to the generic line. Guard the SERVICE tokens (a manual reject with no reason
  // is stored as 'rejected'; 'admin_button' is the bot's no-reason tag) and null/blank → generic.
  // Plain text (no parse_mode at the send site) — no injection surface; the text is admin-authored.
  const custom = reason?.trim();
  if (custom && custom !== 'rejected' && custom !== 'admin_button') return custom;
  return 'Объявление не прошло проверку.';
}

interface AuthorRow {
  telegram_id: string | null;
  allows_write_to_pm: boolean | null;
  is_blocked: boolean | null;
}

/**
 * DM the ad's author about a status change. Announces pending (an apology for the manual-review
 * delay), approved (published, with an "Открыть" button) and rejected (with the reason).
 * Best-effort: never throws.
 *
 * @param sql          the caller's DB handle (so this reuses the caller's already-open connection)
 * @param adId         the user_ads row whose author to notify
 * @param status       the NEW status just written to that row
 * @param rejectReason the stored reject_reason (only used when status === 'rejected')
 * @param prevStatus   the row's PRIOR status; when it equals `status` the notice is SUPPRESSED (a
 *                     re-edit that stayed on the same status → no re-spam). Omit / null for a
 *                     freshly created ad (a transition from nothing → always announced).
 */
export async function notifyAuthorAdDecision(
  sql: Sql,
  adId: string,
  status: string,
  rejectReason: string | null,
  prevStatus: string | null = null,
): Promise<void> {
  // A notice fires ONLY on a REAL status transition: prevStatus === status means a re-edit landed
  // on the SAME status → stay silent (owner rule, no re-spam). null prevStatus = a fresh ad.
  if (prevStatus !== null && prevStatus === status) return;
  // Announced statuses only: pending / approved / rejected. Anything else stays silent.
  if (status !== 'approved' && status !== 'rejected' && status !== 'pending') return;

  try {
    const rows = (await sql`
      select u.telegram_id::text as telegram_id, u.allows_write_to_pm, u.is_blocked
      from user_ads a join users u on u.id = a.author_user_id
      where a.id = ${adId}::uuid
      limit 1`) as unknown as AuthorRow[];
    const r = rows[0];
    // Only DM a reachable author: PM-writable and not blocked (same gate as runNotify).
    if (!r || !r.telegram_id || r.allows_write_to_pm !== true || r.is_blocked === true) return;

    if (status === 'approved') {
      // Reuse notify/run.ts's deep-link trick: an "Открыть" web_app button on /feed/<adId>.
      // With APP_URL unset there is no way to deep-link, so degrade to a text-only notice.
      const appUrl = process.env.APP_URL;
      const extra = appUrl
        ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть', web_app: { url: feedUrl(appUrl, adId) } }]] } }
        : {};
      await sendMessage(
        r.telegram_id,
        '✅ Твоё объявление опубликовано — теперь его видят соискатели. ' +
          'Открой, чтобы посмотреть, как оно выглядит.',
        extra,
      );
    } else if (status === 'pending') {
      // Ad routed to MANUAL review → apologise for the delay (owner rule, 2026-07-23). No button:
      // there is nothing to open yet. Fires ONLY on a transition INTO pending (prevStatus gate).
      await sendMessage(
        r.telegram_id,
        '🕵️ Твоё объявление ушло на проверку — так бывает с некоторыми объявлениями. ' +
          'Извини за задержку, обычно это быстро. Как проверим — сразу сообщим.',
      );
    } else {
      await sendMessage(
        r.telegram_id,
        `⚠️ Твоё объявление отклонено.\n\n${rejectReasonText(rejectReason)}\n\n` +
          'Поправь текст — понятное описание работы, город и контакт — и попробуй разместить снова.',
      );
    }
  } catch {
    // Best-effort: a lookup or DM failure must never break the caller (the ad is already saved).
    // eslint-disable-next-line no-console
    console.error('[notify] author ad-decision notify failed');
  }
}
