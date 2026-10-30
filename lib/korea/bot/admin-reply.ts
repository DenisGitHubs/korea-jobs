// lib/korea/bot/admin-reply.ts
//
// «Ответить через бота» — the way back to a person who wrote to the bot.
//
// WHY THIS EXISTS
// The admin inbox DM (bot/inbox.ts) used to offer «Ответить: tg://user?id=…». For a person without
// a @username that link does not open — Telegram privacy hides the account — so exactly the people
// who could not be reached any other way could not be answered. Now the admin simply REPLIES
// (swipe → reply) to the bot's «✉️ Написали в бот» DM and the bot sends that text to the person.
//
// WHEN IT FIRES (decided by the webhook before calling in here)
//   * private chat;
//   * the message is a reply to a message written by OUR bot (from.is_bot and from.id == the id in
//     BOT_TOKEN);
//   * the sender is an admin (isAdminTelegram — env ADMIN_TELEGRAM_IDS ∪ users.role='admin', the
//     same set adminRecipients DMs; fail-closed on a lookup error);
//   * the reply is not one of the bot's KNOWN commands (an admin typing /stats as a reply still
//     gets /stats).
// The replied-to bot message is then either an inbox DM (→ relayAdminReply) or anything else, e.g.
// «✅ Отправлено» (→ the admin gets ADMIN_REPLY_COPY.notInboxDm; nothing enters the inbox).
// A NON-admin falls through to the normal handling and is never relayed anywhere.
//
// CONTRACT
//   * The recipient comes ONLY from the replied-to DM, which the bot itself wrote (inboxDmTarget:
//     third line, « · id N[ · msg M]» anchored at the end of the line). With M the answer is sent
//     as a reply to the person's own message (allow_sending_without_reply: a deleted message must
//     not block the answer).
//   * The admin's text is sent VERBATIM (after ADMIN_REPLY_PREFIX, empty by default) with NO
//     parse_mode — it is data. The only extra is reply_parameters.
//   * Text only. A photo, sticker, voice, file or a captioned photo gets a hint to the admin instead
//     (sending just a caption without its picture would mislead the person).
//   * Refused up front, with a plain reason: an empty/whitespace text, a text over TG_TEXT_MAX, a
//     text starting with «/» (looks like a command — the person would get a dead command).
//   * An EDITED reply is not resent (it would reach the person a second time); the admin is told.
//   * The relay never enters the inbox: no bot_inbox row, no forward to the admins, no inbox limits.
//     (The webhook's generic 20-updates-per-minute guard still applies to everybody.)
//   * 403 marks users.is_blocked, exactly as the notify/broadcast/digest workers do.
//   * The admin always learns the outcome: «✅ Отправлено» or a plain-words reason.
//   * LOGS carry an outcome LABEL only — never the text, never an id.
//   * Never throws: the webhook must still answer Telegram 200.

import { inboxDmTarget } from './inbox.js';
import type { TgResponse } from './telegram.js';

/** Bot API sendMessage text limit (characters). */
export const TG_TEXT_MAX = 4096;

/**
 * Put in front of every relayed answer so the person can tell a live answer from the bot's own
 * messages (owner's decision, 30.10.2026). The length check below already counts it.
 */
export const ADMIN_REPLY_PREFIX = 'Ответ команды «Работа в Корее»:\n\n';

export type AdminReplyOutcome =
  | 'sent'
  | 'blocked'
  | 'rate_limited'
  | 'rejected'
  | 'unknown'
  | 'not_text'
  | 'empty'
  | 'too_long'
  | 'command'
  | 'edited'
  | 'no_target'
  | 'not_inbox_dm';

export interface AdminReplyInput {
  /** The admin's private chat with the bot (where the confirmation goes). */
  adminChatId: number;
  /** Text of the replied-to bot DM («✉️ Написали в бот …»). */
  dmText: string;
  /** message.text of the admin's reply — null for a photo/sticker/voice/file (caption ignored). */
  text: string | null;
  /** The update is an edited_message. */
  edited: boolean;
}

export interface AdminReplyDeps {
  send: (
    chatId: number | string,
    text: string,
    extra?: Record<string, unknown>,
  ) => Promise<TgResponse<{ message_id: number }>>;
  /** Mark the person as having blocked the bot (users.is_blocked). Best-effort. */
  markBlocked: (telegramId: number) => Promise<void>;
}

/** What the admin is told, per outcome. Plain text. */
export const ADMIN_REPLY_COPY = {
  sent: '✅ Отправлено',
  blocked: '❌ Не доставлено: человек заблокировал бота или удалил аккаунт.',
  rateLimited: (seconds: number) =>
    `❌ Не отправлено: Telegram просит подождать ${seconds} с. Ответьте ещё раз чуть позже.`,
  rejected: (code: number | null) =>
    `❌ Не отправлено: Telegram отказал${code !== null ? ` (код ${code})` : ''}. Попробуйте ещё раз позже.`,
  unknown:
    '⚠️ Telegram не ответил вовремя — неизвестно, дошёл ли ответ. ' +
    'Если повторите, человек может получить его дважды.',
  notText:
    'Пока бот передаёт только текст — фото, стикеры, голосовые и файлы не отправляются. ' +
    'Напишите ответ словами.',
  empty: 'Ответ пустой — отправлять нечего. Напишите текст ответа.',
  tooLong: (length: number, max: number) =>
    `❌ Не отправлено: в ответе ${length} знаков, а Telegram пропускает не больше ${max}. ` +
    'Сократите или разбейте на несколько ответов.',
  command:
    'Это похоже на команду — человеку не отправлено. ' +
    'Если нужно отправить текст, который начинается с «/», начните его с другого знака, например с кавычки.',
  edited:
    'Исправления бот не передаёт — эта правка человеку не отправлена. ' +
    'Нужна поправка — ответьте на обращение ещё раз новым сообщением.',
  noTarget: 'Не понял, кому ответить. Свайпните исходное сообщение «✉️ Написали в бот».',
  notInboxDm: 'Чтобы ответить человеку, свайпните его обращение «✉️ Написали в бот».',
} as const;

function logOutcome(outcome: AdminReplyOutcome): void {
  // Label only: no text, no chat/user id.
  // eslint-disable-next-line no-console
  console.info('[bot] admin reply:', outcome);
}

async function tellAdmin(deps: Pick<AdminReplyDeps, 'send'>, chatId: number, text: string): Promise<void> {
  try {
    await deps.send(chatId, text);
  } catch {
    // eslint-disable-next-line no-console
    console.error('[bot] admin reply: confirmation to admin failed');
  }
}

/**
 * The admin replied to a bot message that is NOT an inbox DM (his own «✅ Отправлено», a /stats
 * report…). Not relayed and not an inbox message — just tell him how to answer. An edit of such a
 * reply is ignored silently (nothing to explain twice).
 */
export async function adminReplyToOtherBotMessage(
  input: { adminChatId: number; edited: boolean },
  deps: Pick<AdminReplyDeps, 'send'>,
): Promise<AdminReplyOutcome> {
  if (!input.edited) await tellAdmin(deps, input.adminChatId, ADMIN_REPLY_COPY.notInboxDm);
  logOutcome('not_inbox_dm');
  return 'not_inbox_dm';
}

/** Relay one admin reply to the person named in the replied-to inbox DM. Never throws. */
export async function relayAdminReply(input: AdminReplyInput, deps: AdminReplyDeps): Promise<AdminReplyOutcome> {
  const done = async (outcome: AdminReplyOutcome, note: string): Promise<AdminReplyOutcome> => {
    await tellAdmin(deps, input.adminChatId, note);
    logOutcome(outcome);
    return outcome;
  };

  if (input.edited) return done('edited', ADMIN_REPLY_COPY.edited);
  if (input.text === null) return done('not_text', ADMIN_REPLY_COPY.notText);
  if (input.text.trim().length === 0) return done('empty', ADMIN_REPLY_COPY.empty);
  if (input.text.trimStart().startsWith('/')) return done('command', ADMIN_REPLY_COPY.command);

  const body = ADMIN_REPLY_PREFIX + input.text;
  if (body.length > TG_TEXT_MAX) return done('too_long', ADMIN_REPLY_COPY.tooLong(body.length, TG_TEXT_MAX));

  const target = inboxDmTarget(input.dmText);
  if (target === null) return done('no_target', ADMIN_REPLY_COPY.noTarget);

  // reply_parameters attaches the answer to the person's own message; allow_sending_without_reply
  // keeps the answer flowing if they deleted it. No parse_mode — the admin's words are data.
  const extra =
    target.messageId !== null
      ? { reply_parameters: { message_id: target.messageId, allow_sending_without_reply: true } }
      : undefined;

  let r: TgResponse<{ message_id: number }>;
  try {
    r = extra ? await deps.send(target.userId, body, extra) : await deps.send(target.userId, body);
  } catch {
    // Transport fault / timeout: Telegram may or may not have delivered it.
    return done('unknown', ADMIN_REPLY_COPY.unknown);
  }

  if (r?.ok !== false) return done('sent', ADMIN_REPLY_COPY.sent);
  if (r.error_code === 403) {
    try {
      await deps.markBlocked(target.userId);
    } catch {
      // eslint-disable-next-line no-console
      console.error('[bot] admin reply: is_blocked update failed');
    }
    return done('blocked', ADMIN_REPLY_COPY.blocked);
  }
  if (r.error_code === 429) {
    const ra = r.parameters?.retry_after;
    const seconds = typeof ra === 'number' && Number.isFinite(ra) && ra >= 0 ? Math.ceil(ra) : 30;
    return done('rate_limited', ADMIN_REPLY_COPY.rateLimited(seconds));
  }
  return done(
    'rejected',
    ADMIN_REPLY_COPY.rejected(typeof r.error_code === 'number' ? r.error_code : null),
  );
}
