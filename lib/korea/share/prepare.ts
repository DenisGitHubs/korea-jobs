// lib/korea/share/prepare.ts
//
// POST /api/share/prepare — mint a Telegram "prepared inline message" (Bot API 8.0,
// savePreparedInlineMessage) so the Mini App can pop a branded SHARE CARD via the native share
// dialog. Two shapes, chosen by the body's `kind`:
//   * kind:"vacancy" (DEFAULT, back-compat) — share ONE vacancy: firm photo + "{role} — вакансия
//     в Корее" + an "Открыть вакансию" button deep-linking to that card WITH the sharer's referral
//     code (attribution survives the share). vacancyId required.
//   * kind:"app" — share the APP itself (invite): firm photo + the app pitch + an "Открыть
//     приложение" button pointing at the sharer's INVITE link (bare 16-hex referral code). No
//     vacancyId.
//
// SECURITY (007 boundary):
//   * user_id passed to the Bot API is the AUTHENTICATED telegram_id (context.ts) — NEVER the
//     request body. The prepared message is minted for the verified caller only.
//   * The referral code baked into the button url is the caller's OWN public_id read from the
//     verified identity — the client cannot forge attribution onto someone else.
//   * Vacancy title/description are run through scrubContacts (defense in depth) so a contact that
//     slipped past the parser can never leak onto a public share card.
//
// The prepared-message id is short-lived (Telegram stamps expiration_date) — minted per request,
// NEVER cached.
//
// DEGRADATION: any Bot API failure (or the feature being unavailable on this bot) → { ok:true,
// fallback:true } (HTTP 200) so the client falls back to a plain share link instead of a 500.
// Only OUR OWN faults (bad body → 400, missing vacancy → 404, DB error → 500 with errorId) error.
//
// COPY lives in ./copy.js (single source, so a legal review edits text in one place).

import { randomUUID } from 'node:crypto';
import { getSql } from '../core/db.js';
import { type ReqLike, type ResLike, send, sendError, readJsonBody } from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { authenticate } from '../core/context.js';
import { scrubContacts } from '../core/scrub.js';
import { workTypeLabel } from '../core/labels.js';
import { buildShareStartParam } from '../core/start-param.js';
import { buildMiniAppDeepLink } from '../core/deep-link.js';
import { tgCall } from '../bot/telegram.js';
import { type ShareLocale, shareLocale, SHARE_COPY } from './copy.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The single branded share image, rendered by the design side and served same-origin (must be an
// HTTPS JPEG for InlineQueryResultPhoto). Bytes live in app/public/share-card.jpg.
const SHARE_CARD_URL = 'https://korea-jobs-omega.vercel.app/share-card.jpg';

// The scrubber's redaction marker (kept in sync with core/scrub.ts REDACT). A field that scrubs
// down to just this marker is dropped from the card rather than shown as "[скрыто]".
const REDACTED = '[скрыто]';

// Keep the description readable; a conservative cap, not a Bot API hard limit.
const DESC_MAX = 90;

export type ShareKind = 'vacancy' | 'app';

/** cities.name is a localized jsonb `{ ru, ko, en }`. */
interface CardRow {
  work_type: string;
  salary_text: string | null;
  city_name: Record<string, unknown> | null;
}

/** The rendered card: what actually goes onto the InlineQueryResultPhoto. */
interface RenderedCard {
  title: string;
  description: string;
  openUrl: string;
  buttonText: string;
}

/**
 * Resolve the request's share kind. DEFAULT is "vacancy" (back-compat: the existing `{vacancyId}`
 * body carries no `kind`). Only the explicit literal "app" switches to the invite card; anything
 * else (absent / unknown) stays "vacancy", where vacancyId validation then applies.
 */
export function resolveShareKind(raw: unknown): ShareKind {
  return raw === 'app' ? 'app' : 'vacancy';
}

/** Trim to `max`, adding an ellipsis when cut. */
function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Pick a city's display name for the locale from its jsonb, falling back RU → any string → null. */
export function pickCityName(cityName: unknown, locale: ShareLocale): string | null {
  if (!cityName || typeof cityName !== 'object') return null;
  const n = cityName as Record<string, unknown>;
  const primary = locale === 'en' ? n.en : n.ru;
  const value =
    typeof primary === 'string' && primary.trim().length > 0
      ? primary
      : typeof n.ru === 'string'
        ? n.ru
        : null;
  return value ? value.trim() : null;
}

/** Vacancy card display fields (city already localized to a string). */
export interface VacancyCardInput {
  work_type: string;
  city: string | null;
  salary_text: string | null;
}

/**
 * Compose the vacancy card's title ("{role} — вакансия в Корее") and description ("город ·
 * зарплата"). The role is the localized work-type label; the description drops any part that is
 * empty OR scrubs to a redaction marker, so there is never a stray " · " separator. Pure +
 * exported so it is unit-testable without a DB / the Bot API.
 */
export function buildVacancyCardText(
  input: VacancyCardInput,
  locale: ShareLocale,
): { title: string; description: string } {
  const role = workTypeLabel(input.work_type, locale);
  const title = SHARE_COPY[locale].vacancyTitle(role);

  const cityClean = (input.city ?? '').trim();
  const salaryClean = (scrubContacts(input.salary_text) ?? '').trim();
  const parts = [cityClean, salaryClean].filter((p) => p.length > 0 && !p.includes(REDACTED));
  const description = (scrubContacts(truncate(parts.join(' · '), DESC_MAX)) ?? '').trim();

  return { title, description };
}

/** The app (invite) card copy for the locale. */
export function buildAppCardText(locale: ShareLocale): { title: string; description: string } {
  return { title: SHARE_COPY[locale].appTitle, description: SHARE_COPY[locale].appDescription };
}

/**
 * Build the InlineQueryResultPhoto and mint the prepared inline message FOR THE VERIFIED CALLER.
 * On success → 200 { ok, preparedMessageId, expiresAt }; on ANY Bot API failure → 200 { ok,
 * fallback:true } so the client degrades to a plain link. Never 500s on a Telegram fault.
 */
async function mintAndRespond(res: ResLike, telegramId: number, card: RenderedCard): Promise<void> {
  const result = {
    type: 'photo',
    id: randomUUID(), // 36 chars, within the 1-64 limit; unique per request
    photo_url: SHARE_CARD_URL,
    // thumbnail_url is REQUIRED for InlineQueryResultPhoto — reuse the same branded image.
    thumbnail_url: SHARE_CARD_URL,
    title: card.title,
    ...(card.description ? { description: card.description } : {}),
    // `url` (NOT web_app) so the button opens the Mini App EVERYWHERE, incl. groups/channels.
    reply_markup: { inline_keyboard: [[{ text: card.buttonText, url: card.openUrl }]] },
  };

  try {
    const resp = await tgCall<{ id: string; expiration_date: number }>('savePreparedInlineMessage', {
      user_id: telegramId,
      result,
      allow_user_chats: true,
      allow_bot_chats: true,
      allow_group_chats: true,
      allow_channel_chats: true,
    });
    if (resp.ok && resp.result?.id) {
      return send(res, 200, {
        ok: true,
        preparedMessageId: resp.result.id,
        expiresAt: resp.result.expiration_date,
      });
    }
    // Bot API said "not ok" — log the code (never the token — tgCall masks) and fall back.
    // eslint-disable-next-line no-console
    console.error(`[share] savePreparedInlineMessage not ok: ${resp.error_code ?? '?'}`);
    return send(res, 200, { ok: true, fallback: true });
  } catch (err) {
    // Transport/timeout to Telegram — the thrown message is already token-masked by tgCall.
    // eslint-disable-next-line no-console
    console.error(`[share] savePreparedInlineMessage failed: ${err instanceof Error ? err.message : String(err)}`);
    return send(res, 200, { ok: true, fallback: true });
  }
}

/** POST /api/share/prepare — see file header for the two card shapes + the response contract. */
export async function sharePrepare(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') return sendError(res, ApiErrorCode.NotFound);
  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, ApiErrorCode.Unauthorized);

  const body = (await readJsonBody(req)) as { kind?: unknown; vacancyId?: unknown } | null;
  const kind = resolveShareKind(body?.kind);
  const locale = shareLocale(auth.user.lang);
  const telegramId = Number(auth.user.telegramId);
  const copy = SHARE_COPY[locale];

  // ── APP (invite) card: no vacancy needed; the button is the sharer's plain invite link. ──
  if (kind === 'app') {
    const openUrl = await buildMiniAppDeepLink(auth.user.publicId); // bare 16-hex ref code
    const { title, description } = buildAppCardText(locale);
    return mintAndRespond(res, telegramId, { title, description, openUrl, buttonText: copy.appButton });
  }

  // ── VACANCY card: vacancyId required; resolve the offer, then deep-link with the ref code. ──
  const vacancyId = typeof body?.vacancyId === 'string' ? body.vacancyId.trim().toLowerCase() : '';
  if (!UUID_RE.test(vacancyId)) return sendError(res, ApiErrorCode.BadRequest);

  let row: CardRow | null = null;
  try {
    const sql = getSql();
    const vac = (await sql`
      select v.work_type::text as work_type, v.salary_text, c.name as city_name
      from vacancies v
      left join cities c on c.id = v.city_id
      where v.id = ${vacancyId}::uuid and v.is_active and v.duplicate_of is null
      limit 1`) as unknown as CardRow[];
    row = vac[0] ?? null;
    if (!row) {
      const ad = (await sql`
        select a.work_type::text as work_type, a.salary_text, c.name as city_name
        from user_ads a
        left join cities c on c.id = a.city_id
        where a.id = ${vacancyId}::uuid and a.status = 'approved' and (a.expires_at is null or a.expires_at > now())
        limit 1`) as unknown as CardRow[];
      row = ad[0] ?? null;
    }
  } catch (err) {
    return sendError(res, ApiErrorCode.Internal, 'share_prepare_db', err);
  }
  if (!row) return sendError(res, ApiErrorCode.NotFound);

  const { title, description } = buildVacancyCardText(
    { work_type: row.work_type, city: pickCityName(row.city_name, locale), salary_text: row.salary_text },
    locale,
  );

  const startParam = buildShareStartParam(vacancyId, auth.user.publicId);
  if (!startParam) return sendError(res, ApiErrorCode.Internal, 'share_prepare_startparam');
  const openUrl = await buildMiniAppDeepLink(startParam);

  return mintAndRespond(res, telegramId, { title, description, openUrl, buttonText: copy.vacancyButton });
}
