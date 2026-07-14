// lib/korea/bot/telegram.ts
//
// Thin fetch client for the Telegram Bot API. The ONLY module that builds an
// api.telegram.org/bot<token>/... URL, so it is also the ONLY place the bot token
// touches an outbound string — and it NEVER lets that token reach a log or an error
// message (maskToken scrubs every error surface).
//
// Narrow surface: tgCall + sendMessage + setWebhook/setMyCommands + maskToken +
// isUserUnavailable + retryAfterSeconds.
//
// PROTOCOL (Susanin brief, verified by 007 — 2026-07-13):
//   * BOT_TOKEN comes ONLY from process.env; the URL is a secret, never logged.
//   * Bot API responses are { ok, result?, error_code?, description?, parameters? };
//     a 429 carries parameters.retry_after (seconds) which callers MUST respect.
//   * A 403 (bot blocked / never started) => recipient unavailable: not fatal, do
//     not retry. isUserUnavailable() classifies it (notify path flips users.is_blocked).
//   * Every call has a timeout (AbortController).

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_CALL_TIMEOUT_MS = 8_000;

/** The Bot API response envelope (only the fields we act on). */
export interface TgResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: {
    /** Seconds to wait before retrying, present on a 429. */
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}

/** Read the bot token from env, failing loud on misconfig (never logs the value). */
function botToken(): string {
  const t = process.env.BOT_TOKEN;
  if (!t) {
    throw new Error('telegram: BOT_TOKEN is not set');
  }
  return t;
}

/**
 * Replace every occurrence of the bot token in `text` with a fixed mask. Uses
 * split/join (not regex) because the token contains regex-special chars (":").
 */
export function maskToken(text: string, token: string | undefined = process.env.BOT_TOKEN): string {
  if (!token || token.length === 0) return text;
  return text.split(token).join('***');
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export interface TgCallOptions {
  timeoutMs?: number;
}

/**
 * Call a Bot API method with a JSON body. Returns the parsed envelope for ANY HTTP
 * status (incl. 4xx/429/5xx) so callers branch on ok / error_code / retry_after
 * without try/catch for the "not ok" path. THROWS only on a transport/timeout/parse
 * fault — and that thrown error is token-masked. Never logs anything itself.
 */
export async function tgCall<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  opts: TgCallOptions = {},
): Promise<TgResponse<T>> {
  const token = botToken();
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    return (await res.json()) as TgResponse<T>;
  } catch (err) {
    // The URL carries the token; NEVER let it leak through an error string.
    throw new Error(`tgCall ${method} failed: ${maskToken(errorMessage(err), token)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Send a text message to a chat. `extra` carries optional fields (reply_markup, parse_mode, ...). */
export function sendMessage(
  chatId: number | string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<TgResponse<{ message_id: number }>> {
  return tgCall('sendMessage', { chat_id: chatId, text, ...extra });
}

/** Acknowledge a callback_query (stops the client spinner). Optional toast `text`. */
export function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<TgResponse> {
  return tgCall('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

/** Edit a sent message's text (used to drop the inline keyboard after a decision). */
export function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<TgResponse> {
  return tgCall('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra });
}

/**
 * Classify "recipient unavailable" (a 403: user blocked the bot / never started it /
 * deactivated). De-facto behaviour. The notify worker suppresses the send, does NOT
 * retry, and flips users.is_blocked = true.
 */
export function isUserUnavailable(resp: TgResponse): boolean {
  return resp.ok === false && resp.error_code === 403;
}

/**
 * Extract retry_after (seconds) a 429 asks callers to wait. Returns null when the
 * response is not a rate-limit with a numeric retry_after.
 */
export function retryAfterSeconds(resp: TgResponse): number | null {
  if (resp.ok === false && resp.error_code === 429) {
    const ra = resp.parameters?.retry_after;
    if (typeof ra === 'number' && Number.isFinite(ra) && ra >= 0) return ra;
  }
  return null;
}
