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
} from '../core/http.js';
import { sendMessage, maskToken } from './telegram.js';

const RATE_LIMIT_PER_MINUTE = 20;

interface ParsedUpdate {
  updateId: number;
  fromId: number | null;
  chatId: number | null;
  text: string | null;
}

function parseUpdate(body: unknown): ParsedUpdate | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const updateId = b.update_id;
  if (typeof updateId !== 'number') return null;
  const msg = (b.message ?? b.edited_message) as Record<string, unknown> | undefined;
  const from = msg?.from as Record<string, unknown> | undefined;
  const chat = msg?.chat as Record<string, unknown> | undefined;
  return {
    updateId,
    fromId: typeof from?.id === 'number' ? from.id : null,
    chatId: typeof chat?.id === 'number' ? chat.id : null,
    text: typeof msg?.text === 'string' ? msg.text : null,
  };
}

/** Handle a parsed update. Only /start is meaningful for now. */
async function dispatch(u: ParsedUpdate): Promise<void> {
  if (u.chatId === null || u.fromId === null) return;
  const text = (u.text ?? '').trim();
  if (!text.startsWith('/start')) return;

  // Starting the bot makes the user PM-writable → mark it so notifications can reach them.
  const sql = getSql();
  await sql`
    insert into users (telegram_id, allows_write_to_pm)
    values (${u.fromId}::bigint, true)
    on conflict (telegram_id) do update set allows_write_to_pm = true, last_seen_at = now()`;

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
  if ((req.method ?? 'GET') !== 'POST') {
    res.statusCode = 404;
    res.end('');
    return;
  }

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
    // Never surface a non-2xx to Telegram. (Token-masked; no payload logged.)
    void maskToken(String(err));
  }

  // (f) ALWAYS 200.
  return ack(res);
}
