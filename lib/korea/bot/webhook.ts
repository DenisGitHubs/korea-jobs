// lib/korea/bot/webhook.ts
//
// POST /api/bot/webhook — the Telegram webhook. CONTRACT (cargobob pattern,
// Susanin/007 verified):
//   (a) constant-time check X-Telegram-Bot-Api-Secret-Token == TG_WEBHOOK_SECRET → 401.
//   (b) parse the update.
//   (c) FIRST DB action: INSERT update_id (PK). Conflict = Telegram retry → ack 200.
//   (d) durable per-sender rate limit (>20 updates/60s) → ack without dispatch.
//   (e) dispatch (best-effort; never throws out).
//   (f) ALWAYS answer 200 — any non-2xx makes Telegram retry-storm.

import { getSql } from '../core/db.js';
import {
  type ReqLike,
  type ResLike,
  header,
  readJsonBody,
  constantTimeEquals,
  sendError,
} from '../core/http.js';
import { ApiErrorCode } from '../core/errors.js';
import { sendMessage, answerCallbackQuery, editMessageText, maskToken } from './telegram.js';
import { isAdminTelegramId } from '../admin/auth.js';
import { moderateAd } from '../ads/rw.js';
import { normalizeRefCode } from '../core/context.js';
import { getConfigNumber } from '../config.js';

const RATE_LIMIT_PER_MINUTE = 20;

interface CallbackData {
  id: string;
  data: string | null;
  messageId: number | null;
}

interface ParsedUpdate {
  updateId: number;
  fromId: number | null;
  chatId: number | null;
  chatType: string | null;
  text: string | null;
  callback: CallbackData | null;
}

function parseUpdate(body: unknown): ParsedUpdate | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const updateId = b.update_id;
  if (typeof updateId !== 'number') return null;

  // callback_query (inline button press — used for ad moderation).
  const cq = b.callback_query as Record<string, unknown> | undefined;
  if (cq) {
    const cqFrom = cq.from as Record<string, unknown> | undefined;
    const cqMsg = cq.message as Record<string, unknown> | undefined;
    const cqChat = cqMsg?.chat as Record<string, unknown> | undefined;
    return {
      updateId,
      fromId: typeof cqFrom?.id === 'number' ? cqFrom.id : null,
      chatId: typeof cqChat?.id === 'number' ? cqChat.id : null,
      chatType: typeof cqChat?.type === 'string' ? cqChat.type : null,
      text: null,
      callback: {
        id: typeof cq.id === 'string' ? cq.id : '',
        data: typeof cq.data === 'string' ? cq.data : null,
        messageId: typeof cqMsg?.message_id === 'number' ? cqMsg.message_id : null,
      },
    };
  }

  const msg = (b.message ?? b.edited_message) as Record<string, unknown> | undefined;
  const from = msg?.from as Record<string, unknown> | undefined;
  const chat = msg?.chat as Record<string, unknown> | undefined;
  return {
    updateId,
    fromId: typeof from?.id === 'number' ? from.id : null,
    chatId: typeof chat?.id === 'number' ? chat.id : null,
    chatType: typeof chat?.type === 'string' ? chat.type : null,
    text: typeof msg?.text === 'string' ? msg.text : null,
    callback: null,
  };
}

const CB_RE = /^ad:(approve|reject):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const REPORT_CB_RE = /^rep:(hide|keep):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Handle an inline button (ad moderation / report action). Admin-gated by ADMIN_TELEGRAM_IDS. */
async function dispatchCallback(u: ParsedUpdate): Promise<void> {
  const cb = u.callback;
  if (!cb) return;
  // Only configured admins may act; others get a soft toast.
  if (u.fromId === null || !isAdminTelegramId(u.fromId)) {
    if (cb.id) await answerCallbackQuery(cb.id, 'Недоступно');
    return;
  }
  const data = cb.data ?? '';

  // (1) Ad moderation: ad:approve / ad:reject.
  const adM = CB_RE.exec(data);
  if (adM) {
    const action = adM[1]!.toLowerCase() as 'approve' | 'reject';
    const adId = adM[2]!;
    const { found } = await moderateAd(adId, action, action === 'reject' ? 'admin_button' : null);
    const label = action === 'approve' ? 'одобрено' : 'отклонено';
    if (cb.id) await answerCallbackQuery(cb.id, found ? `Решение: ${label}` : 'Не найдено');
    if (found && u.chatId !== null && cb.messageId !== null) {
      await editMessageText(u.chatId, cb.messageId, `Решение: ${label}.`);
    }
    return;
  }

  // (2) Report action: rep:hide / rep:keep. Owner rule — reports only NOTIFY; the admin decides.
  // hide is REVERSIBLE (is_active=false), never a delete. The uuid is validated by REPORT_CB_RE.
  const repM = REPORT_CB_RE.exec(data);
  if (repM) {
    const action = repM[1]!.toLowerCase() as 'hide' | 'keep';
    const vacId = repM[2]!;
    if (action === 'hide') {
      const sql = getSql();
      const rows = await sql`
        update vacancies set is_active = false where id = ${vacId}::uuid and is_active returning id`;
      const done = rows.length > 0;
      if (cb.id) await answerCallbackQuery(cb.id, done ? 'Скрыто' : 'Уже скрыто');
      if (u.chatId !== null && cb.messageId !== null) {
        await editMessageText(u.chatId, cb.messageId, done ? 'Жалоба: вакансия скрыта.' : 'Жалоба: уже скрыта.');
      }
    } else {
      if (cb.id) await answerCallbackQuery(cb.id, 'Оставлено');
      if (u.chatId !== null && cb.messageId !== null) {
        await editMessageText(u.chatId, cb.messageId, 'Жалоба: вакансия оставлена.');
      }
    }
    return;
  }

  // Unknown callback → just stop the client spinner.
  if (cb.id) await answerCallbackQuery(cb.id);
}

/** Handle a parsed update. /start (message) or ad moderation (callback_query). */
async function dispatch(u: ParsedUpdate): Promise<void> {
  if (u.callback) return dispatchCallback(u);
  if (u.chatId === null || u.fromId === null) return;
  // Only act in a private chat: the PM-writable flag + greeting are meaningless (and
  // wrong) if the bot is ever added to a group/supergroup/channel.
  if (u.chatType !== 'private') return;
  const text = (u.text ?? '').trim();
  if (!text.startsWith('/start')) return;

  // Starting the bot makes the user PM-writable → mark it so notifications can reach
  // them. It is also an authoritative "the bot can DM me" signal: clear is_blocked, so a
  // user who previously triggered a 403 (incl. a false positive) re-enters runNotify.
  //
  // A deep link `t.me/<bot>?start=<code>` arrives as "/start <code>". Same attribution
  // policy as the Mini App (context.ts), so the outcome does not depend on which path
  // inserted the row first: bind the referrer + ancestor snapshot on a genuine INSERT, or
  // on the UPDATE branch ONLY while the existing row is still EMPTY (no referrer, inside
  // the bind window, no activation/contact reveal). Without a code the plain upsert runs
  // untouched. Webhook idempotency is already provided by the bot_updates PK dedup above.
  const refCode = normalizeRefCode(text.slice('/start'.length).trim());
  const sql = getSql();
  if (refCode) {
    const bindWindowHours = await getConfigNumber('referral_bind_window_hours', 72);
    await sql`
      with ref as (
        select id as ref_id, referred_by as l2, ref_l2 as l3
        from users
        where public_id = ${refCode} and telegram_id <> ${u.fromId}::bigint
        limit 1
      )
      insert into users (telegram_id, allows_write_to_pm, referred_by, ref_l2, ref_l3)
      values (
        ${u.fromId}::bigint, true,
        (select ref_id from ref), (select l2 from ref), (select l3 from ref)
      )
      on conflict (telegram_id) do update set
        allows_write_to_pm = true, is_blocked = false, last_seen_at = now(),
        referred_by = case when (select ref_id from ref) is not null
            and users.referred_by is null
            and users.created_at > now() - make_interval(hours => ${bindWindowHours})
            and not exists (select 1 from referral_activations a where a.user_id = users.id)
            and not exists (select 1 from contact_reveals cr where cr.user_id = users.id)
            and not exists (select 1 from ad_contact_reveals ar where ar.user_id = users.id)
          then (select ref_id from ref) else users.referred_by end,
        ref_l2 = case when (select ref_id from ref) is not null
            and users.referred_by is null
            and users.created_at > now() - make_interval(hours => ${bindWindowHours})
            and not exists (select 1 from referral_activations a where a.user_id = users.id)
            and not exists (select 1 from contact_reveals cr where cr.user_id = users.id)
            and not exists (select 1 from ad_contact_reveals ar where ar.user_id = users.id)
          then (select l2 from ref) else users.ref_l2 end,
        ref_l3 = case when (select ref_id from ref) is not null
            and users.referred_by is null
            and users.created_at > now() - make_interval(hours => ${bindWindowHours})
            and not exists (select 1 from referral_activations a where a.user_id = users.id)
            and not exists (select 1 from contact_reveals cr where cr.user_id = users.id)
            and not exists (select 1 from ad_contact_reveals ar where ar.user_id = users.id)
          then (select l3 from ref) else users.ref_l3 end`;
  } else {
    await sql`
      insert into users (telegram_id, allows_write_to_pm)
      values (${u.fromId}::bigint, true)
      on conflict (telegram_id) do update set
        allows_write_to_pm = true, is_blocked = false, last_seen_at = now()`;
  }

  const appUrl = process.env.APP_URL;
  const extra = appUrl
    ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть вакансии', web_app: { url: appUrl } }]] } }
    : {};
  await sendMessage(
    u.chatId,
    'Привет! Здесь свежие вакансии для работы по Корее из телеграм-чатов. Открой приложение, ' +
      'выбери города — и получай подходящие. По подписке буду присылать новые прямо сюда.',
    extra,
  );
}

function ack(res: ResLike): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end('{"ok":true}');
}

function unauthorized(res: ResLike): void {
  res.statusCode = 401;
  res.end('');
}

export async function botWebhook(req: ReqLike, res: ResLike): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, ApiErrorCode.NotFound);

  // (a) secret — constant-time; 401 with no body on mismatch/absence.
  if (!constantTimeEquals(header(req, 'x-telegram-bot-api-secret-token'), process.env.TG_WEBHOOK_SECRET)) {
    return unauthorized(res);
  }

  try {
    const u = parseUpdate(await readJsonBody(req));
    if (!u) return ack(res);

    const sql = getSql();

    // (c) dedup insert (first DB action).
    const ins = await sql`
      insert into bot_updates (update_id, from_id)
      values (${u.updateId}::bigint, ${u.fromId ?? null}::bigint)
      on conflict (update_id) do nothing
      returning update_id`;
    if (ins.length === 0) return ack(res); // Telegram replay

    // (d) durable per-sender rate limit off the ledger.
    if (u.fromId !== null) {
      const cnt = (await sql`
        select count(*)::int as c from bot_updates
        where from_id = ${u.fromId}::bigint and received_at > now() - interval '60 seconds'`) as unknown as {
        c: number;
      }[];
      if ((cnt[0]?.c ?? 0) > RATE_LIMIT_PER_MINUTE) return ack(res);
    }

    // (e) dispatch.
    await dispatch(u);
  } catch (err) {
    // Never surface a non-2xx to Telegram, but DO log the masked error so a systemic
    // webhook failure stays traceable (token masked; no payload logged).
    // eslint-disable-next-line no-console
    console.error('[bot] webhook dispatch error:', maskToken(String(err)));
  }

  // (f) ALWAYS 200.
  return ack(res);
}
