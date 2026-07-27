// lib/korea/bot/inbox.ts
//
// "Написали в бот" — the human inbox behind the Privacy Policy promise.
//
// WHY THIS EXISTS
// The Privacy Policy tells people: «напиши нам @korea_rabota_bot … мы отвечаем в течение 3 рабочих
// дней» (app/src/content/legal/privacy.ts) — that is where a takedown request ("уберите мой номер"),
// a consent withdrawal or a data question arrives. Until this module the webhook dropped every
// non-command message on the floor, so the promise could not be kept. Now a plain private message
// is FORWARDED to the configured admins and the sender gets an honest acknowledgement.
//
// CONTRACT
//   * Private chats only, plain text only, never a command (webhook gates all three).
//   * The admin DM is sent with NO parse_mode: the forwarded text is DATA, so it can never inject
//     Telegram markup (same rule as cooperation/rw.ts). The sender's name is collapsed to one line
//     and capped, so it cannot fake the header either.
//   * The text is capped at INBOX_TEXT_MAX and the person is told when we cut it.
//   * ANTI-SPAM (the owner's inbox is the scarce resource): at most `user_inbox_per_hour` forwards
//     per sender per hour AND `inbox_global_per_day` forwards in 24h across everyone. Both live in
//     the `config` table, so they change without a deploy (0 = forward nothing at all, an
//     emergency stop — the person is still answered politely, never met with silence). Over the
//     limit → a polite reply to the person, NOTHING to the admins; the reply itself is sent ONCE
//     per hour per person (the ledger records that we already answered), so a flooder cannot
//     bounce messages off us.
//   * NEWCOMER RESERVE (007 M1, draft_0029). The global ceiling alone is a denial-of-service on the
//     PROMISE: two flooders at 5/h burn 240 forwards a day, the 200 window fills, and the next
//     «уберите мой номер» is answered politely, never forwarded and never stored (we keep no text)
//     — the request would vanish without a trace. So a sender with ZERO forwards in the last 24h
//     passes OVER a full global window, against a small separate ceiling
//     (`inbox_newcomer_reserve_per_day`, default 30). Flooders cannot touch that budget: their
//     second message of the day is no longer a first one. The reserve exists only ON TOP of a live
//     global ceiling — with inbox_global_per_day = 0 (the documented emergency stop) nothing gets
//     through, newcomers included.
//   * OWNER SIGNAL (007 M1). The first time the global window is exhausted (a reserve forward, or
//     a message actually blocked by it) the admins get ONE DM saying so. It is itself metered —
//     at most one per 24h, claimed with an insert, so it can never become a second flood.
//   * Nothing here throws: the webhook must still answer Telegram 200.
//
// WHAT IS STORED (bot_inbox, draft_0028 + draft_0029): only metadata — sender id, chat id, update
// id, text LENGTH, whether we forwarded and a `kind` marker ('message' | 'reserve' | 'alert').
// NEVER the message text: takedown requests carry phone numbers (third-party PII) and the text
// already lives in the admin's Telegram chat, which is the copy the owner answers from.
//
// DEGRADED MODES (both fail-OPEN on purpose — a silently dropped takedown request breaks a
// published promise, while the flood risk stays bounded by the webhook's own durable
// 20-updates-per-minute-per-sender limit):
//   1. bot_inbox exists but has no `kind` column (code deployed before draft_0029) → the claim is
//      retried in its pre-0029 shape: plain per-hour + per-day ceilings, no reserve, no alert.
//   2. bot_inbox itself is unusable (deploy before draft_0028, DB blip) → we count this sender's
//      updates in bot_updates (which exists since 0001) and let the message through under the same
//      per-hour ceiling.
// Neither mode is cached in module state: the extra failed statement costs nothing at this volume
// (≤ a few hundred inbox messages a day by design) and a stale "legacy" flag on a warm serverless
// instance would silently disable the reserve long after the migration landed.

import { getSql } from '../core/db.js';
import { getConfigNumber } from '../config.js';
import { sendMessage, maskToken, type TgResponse } from './telegram.js';
import { adminRecipients } from '../admin/auth.js';

type Sql = ReturnType<typeof getSql>;

/** Hard cap on the forwarded text; anything longer is cut and the sender is told. */
export const INBOX_TEXT_MAX = 2_000;
/** Forwards per sender per hour (config `user_inbox_per_hour`). */
export const USER_INBOX_PER_HOUR_DEFAULT = 5;
/** Forwards in 24h across everyone (config `inbox_global_per_day`). */
export const INBOX_GLOBAL_PER_DAY_DEFAULT = 200;
/**
 * Forwards in 24h reserved for people whose FIRST message of the day it is, on top of a full
 * global window (config `inbox_newcomer_reserve_per_day`). Keeps a first-time takedown request
 * reaching the owner while two flooders hold the global ceiling down.
 */
export const INBOX_NEWCOMER_RESERVE_PER_DAY_DEFAULT = 30;
/** How many "we throttled you" markers we keep per sender per hour (bounds a flooder's writes). */
export const INBOX_THROTTLE_LOG_MAX = 3;

const NAME_MAX = 64;
const USERNAME_RE = /^[A-Za-z0-9_]{1,32}$/;

export interface InboxSender {
  id: number;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  /** Telegram language_code, used only to pick the reply language. */
  lang?: string | null;
}

export interface InboxMessage {
  updateId: number;
  chatId: number;
  sender: InboxSender;
  text: string;
}

export type InboxOutcome = 'forwarded' | 'throttled' | 'busy' | 'undelivered';

// ─────────────────────────────────────────────────────────────────────────────
// Copy (RU default, EN for en-* — the same two locales the share cards support)
//
// LEGAL: we promise only the PROCESS we control — «получили» and «ответим в течение 3 рабочих
// дней», the exact wording of the Privacy Policy. No promise about the outcome.
// ─────────────────────────────────────────────────────────────────────────────

export type InboxLocale = 'ru' | 'en';

/** Pick the reply locale from a Telegram language_code. Anything non-English falls back to RU. */
export function inboxLocale(lang: string | null | undefined): InboxLocale {
  return typeof lang === 'string' && /^en/i.test(lang) ? 'en' : 'ru';
}

export const INBOX_COPY: Record<
  InboxLocale,
  { ack: string; truncated: string; throttled: string; busy: string; undelivered: string }
> = {
  ru: {
    ack: 'Спасибо, сообщение получили. Ответим в течение 3 рабочих дней.',
    truncated:
      `Сообщение длинное — взяли первые ${INBOX_TEXT_MAX} символов. ` +
      'Если важное осталось за краем, пришлите его отдельным сообщением.',
    throttled:
      'Ваши сообщения уже у нас — ответим в течение 3 рабочих дней. ' +
      'Если нужно что-то добавить, напишите, пожалуйста, через час.',
    busy:
      'Сейчас очень много обращений, и ваше сообщение мы принять не успели. ' +
      'Напишите, пожалуйста, чуть позже — так оно точно дойдёт.',
    undelivered: 'Не получилось передать сообщение. Попробуйте, пожалуйста, ещё раз через несколько минут.',
  },
  en: {
    ack: 'Thanks, we have got your message. We will reply within 3 business days.',
    truncated:
      `Your message is long — we took the first ${INBOX_TEXT_MAX} characters. ` +
      'If something important got cut off, please send it in a separate message.',
    throttled:
      'We already have your messages and will reply within 3 business days. ' +
      'If you need to add something, please write again in an hour.',
    busy:
      'We are getting a lot of messages right now and could not accept yours. ' +
      'Please write again a little later so it reaches us.',
    undelivered: 'We could not pass your message on. Please try again in a few minutes.',
  },
};

/**
 * The DM that tells the OWNER his inbox ceiling is exhausted — plain text, no parse_mode, no
 * personal data (numbers only). Written for a non-engineer: what happened, who still gets through,
 * what to do. Sent at most once per 24h (see alertGlobalCeiling).
 */
export function globalCeilingAlertText(perDay: number, reserve: number): string {
  return (
    '⚠️ Обращения в бот: суточный лимит выбран\n\n' +
    `За последние 24 часа мы приняли ${perDay} сообщений — это потолок. ` +
    'Часть новых сообщений сейчас может до нас не доходить: людям отвечает бот, ' +
    'но в этот чат они не попадают.\n\n' +
    `Тем, кто пишет ВПЕРВЫЕ, мы всё равно отвечаем — для них оставлен отдельный резерв ` +
    `(${reserve} сообщений в сутки).\n\n` +
    'Что делать: разобрать сегодняшние обращения, а если поток настоящий — поднять лимит ' +
    '(ключ inbox_global_per_day в таблице config).\n\n' +
    'Это предупреждение приходит не чаще одного раза в сутки.'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** True for a message that belongs in the inbox: non-empty text that is NOT a command. */
export function isInboxText(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && !t.startsWith('/');
}

/** Trim + cap the text; `truncated` drives the extra line in the reply. */
export function clampInboxText(raw: string): { text: string; truncated: boolean } {
  const t = raw.trim();
  return t.length <= INBOX_TEXT_MAX
    ? { text: t, truncated: false }
    : { text: t.slice(0, INBOX_TEXT_MAX), truncated: true };
}

/** Collapse whitespace (incl. newlines) and cap — a display name must not forge header lines. */
function oneLine(s: string, max: number): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The admin DM. PLAIN TEXT ONLY (the caller must not pass parse_mode): the body is the person's
 * own words, forwarded verbatim, so no markup can be injected. The header carries who wrote and a
 * one-tap way back to them — @username when there is one, else the tg://user id link.
 */
export function adminInboxText(sender: InboxSender, text: string, truncated: boolean): string {
  const name = oneLine([sender.firstName ?? '', sender.lastName ?? ''].join(' '), NAME_MAX);
  const uname = sender.username && USERNAME_RE.test(sender.username) ? sender.username : null;
  const who = [name || null, uname ? '@' + uname : null].filter(Boolean).join(' ') || 'без имени';
  const link = uname ? `https://t.me/${uname}` : `tg://user?id=${sender.id}`;
  return (
    '✉️ Написали в бот\n\n' +
    `От: ${who} · id ${sender.id}\n` +
    `Ответить: ${link}\n\n` +
    text +
    (truncated ? `\n\n(обрезано до ${INBOX_TEXT_MAX} символов)` : '')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger (rate limit) + delivery
// ─────────────────────────────────────────────────────────────────────────────

export interface InboxDeps {
  send: (chatId: number | string, text: string) => Promise<TgResponse<{ message_id: number }>>;
  recipients: (sql: Sql) => Promise<string[]>;
}

const defaultDeps: InboxDeps = { send: sendMessage, recipients: adminRecipients };

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Clamp a config value to a whole, non-negative number (0 = "forward nothing"). */
function whole(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

type Claim =
  | { granted: true; id: string | null; viaReserve: boolean }
  | { granted: false; reason: 'user' | 'global'; notify: boolean };

/** Row id as a string (the ledger's uuid), or null when the driver gave us nothing usable. */
function idOf(row: { id?: unknown } | undefined): string | null {
  const v = row?.id;
  return v === undefined || v === null ? null : String(v);
}

/**
 * The claim, in its full (post-draft_0029) shape: ONE statement that re-counts every window it
 * cares about and inserts only if the message is allowed through. `kind` on the returned row says
 * HOW it got through — 'message' (normal) or 'reserve' (the global window was full and this is the
 * sender's first message of the day).
 *
 * RACE HONESTY (Цензор). One statement is NOT a mutual-exclusion lock. Under READ COMMITTED the
 * counting sub-selects of two concurrent invocations see the same snapshot, so both can pass a
 * window that had exactly one slot left: the ceilings are ACCURATE-ENOUGH, not exact, and the
 * overshoot is bounded by the number of messages genuinely in flight at that instant (a handful).
 * What the single statement DOES buy is that no read-then-write GAP exists in our code and the
 * count is always taken from committed rows, so a full window can never be over-run by an
 * arbitrary amount. A real lock is deliberately NOT taken: the Neon HTTP driver runs every tagged
 * call as its own implicit transaction with no session affinity, so pg_advisory_lock could not be
 * held across statements anyway, and pg_advisory_xact_lock would serialize the whole inbox on one
 * key to buy exactness nobody needs (the ceilings are anti-spam heuristics, not accounting).
 *
 * Returns null when the statement itself fails (e.g. no `kind` column yet) so the caller can fall
 * back — a claim that throws must never cost us the message.
 */
async function claimWithReserve(
  sql: Sql,
  msg: InboxMessage,
  textLen: number,
  perHour: number,
  perDay: number,
  reserve: number,
): Promise<{ id?: unknown; kind?: unknown }[] | null> {
  try {
    return (await sql`
      with w as (
        select
          (select count(*) from bot_inbox
             where from_id = ${msg.sender.id}::bigint and forwarded
               and created_at > now() - interval '1 hour')            as user_hour,
          (select count(*) from bot_inbox
             where forwarded and created_at > now() - interval '24 hours') as global_day,
          (select count(*) from bot_inbox
             where from_id = ${msg.sender.id}::bigint and forwarded
               and created_at > now() - interval '24 hours')          as user_day,
          (select count(*) from bot_inbox
             where kind = 'reserve' and created_at > now() - interval '24 hours') as reserve_day
      )
      insert into bot_inbox (from_id, chat_id, update_id, text_len, forwarded, kind)
      select ${msg.sender.id}::bigint, ${msg.chatId}::bigint, ${msg.updateId}::bigint,
             ${textLen}::int, true,
             (case when w.global_day < ${perDay}::int then 'message' else 'reserve' end)::text
      from w
      where w.user_hour < ${perHour}::int
        and (w.global_day < ${perDay}::int
             or (w.user_day = 0 and w.reserve_day < ${reserve}::int))
      returning id, kind`) as unknown as { id?: unknown; kind?: unknown }[];
  } catch (err) {
    // Most likely a pre-draft_0029 schema (no `kind` column). Fall back to the plain claim below;
    // if bot_inbox is missing altogether that one fails too and we end up on bot_updates.
    // eslint-disable-next-line no-console
    console.error('[bot] inbox reserve claim unavailable (pre-0029 schema?):', maskToken(String(err)));
    return null;
  }
}

/** The pre-draft_0029 claim: per-sender hour + global day only. Returns null when it fails. */
async function claimLegacy(
  sql: Sql,
  msg: InboxMessage,
  textLen: number,
  perHour: number,
  perDay: number,
): Promise<{ id?: unknown }[] | null> {
  try {
    return (await sql`
      insert into bot_inbox (from_id, chat_id, update_id, text_len, forwarded)
      select ${msg.sender.id}::bigint, ${msg.chatId}::bigint, ${msg.updateId}::bigint,
             ${textLen}::int, true
      where (select count(*) from bot_inbox
               where from_id = ${msg.sender.id}::bigint and forwarded
                 and created_at > now() - interval '1 hour') < ${perHour}::int
        and (select count(*) from bot_inbox
               where forwarded and created_at > now() - interval '24 hours') < ${perDay}::int
      returning id`) as unknown as { id?: unknown }[];
  } catch (err) {
    // Ledger unusable (missing table in a deploy-before-migrate window, DB blip) → degraded mode.
    // eslint-disable-next-line no-console
    console.error('[bot] inbox ledger unavailable:', maskToken(String(err)));
    return null;
  }
}

/**
 * 0 rows came back from a claim: we are over a limit. One extra read tells us WHICH limit and
 * whether this person has already been answered inside the current hour (we answer once, then
 * stay silent).
 */
async function blockedClaim(
  sql: Sql,
  msg: InboxMessage,
  textLen: number,
  perHour: number,
): Promise<Claim> {
  try {
    const rows = (await sql`
      select
        (select count(*)::int from bot_inbox
           where from_id = ${msg.sender.id}::bigint and forwarded
             and created_at > now() - interval '1 hour') as user_hour,
        (select count(*)::int from bot_inbox
           where from_id = ${msg.sender.id}::bigint and not forwarded
             and created_at > now() - interval '1 hour') as notes`) as unknown as {
      user_hour: number;
      notes: number;
    }[];
    const userHour = num(rows[0]?.user_hour);
    const notes = num(rows[0]?.notes);
    // Keep a bounded number of "throttled" markers: enough to remember that we answered, not so
    // many that a flooder can grow the table one row per message.
    if (notes < INBOX_THROTTLE_LOG_MAX) {
      await sql`
        insert into bot_inbox (from_id, chat_id, update_id, text_len, forwarded)
        values (${msg.sender.id}::bigint, ${msg.chatId}::bigint, ${msg.updateId}::bigint,
                ${textLen}::int, false)`;
    }
    return { granted: false, reason: userHour >= perHour ? 'user' : 'global', notify: notes === 0 };
  } catch (err) {
    // The ceiling itself is not in doubt (the claim ran) — only the follow-up read failed. Stay
    // blocked and stay silent rather than risk answering the same person on every message.
    // eslint-disable-next-line no-console
    console.error('[bot] inbox throttle bookkeeping failed:', maskToken(String(err)));
    return { granted: false, reason: 'user', notify: false };
  }
}

/**
 * Take one forward slot: full claim → pre-0029 claim → bot_updates fallback. Never throws.
 */
async function claimInboxSlot(
  sql: Sql,
  msg: InboxMessage,
  textLen: number,
  perHour: number,
  perDay: number,
  reserve: number,
): Promise<Claim> {
  const claimed = await claimWithReserve(sql, msg, textLen, perHour, perDay, reserve);
  if (claimed === null) {
    const legacy = await claimLegacy(sql, msg, textLen, perHour, perDay);
    if (legacy === null) return fallbackClaim(sql, msg, perHour);
    const row = legacy[0];
    if (row) return { granted: true, id: idOf(row), viaReserve: false };
    return blockedClaim(sql, msg, textLen, perHour);
  }

  const row = claimed[0];
  if (row) return { granted: true, id: idOf(row), viaReserve: row.kind === 'reserve' };
  return blockedClaim(sql, msg, textLen, perHour);
}

/**
 * Degraded limiter used only when bot_inbox is unusable: count this sender's updates in the
 * webhook's own ledger (bot_updates, indexed on (from_id, received_at)). It over-counts (commands
 * and /start land there too), which is the safe direction. No reply is sent when it blocks — we
 * have no way to remember that we already answered, and answering every message would be a flood.
 */
async function fallbackClaim(sql: Sql, msg: InboxMessage, perHour: number): Promise<Claim> {
  try {
    const rows = (await sql`
      select count(*)::int as c from bot_updates
      where from_id = ${msg.sender.id}::bigint and received_at > now() - interval '1 hour'`) as unknown as {
      c: number;
    }[];
    if (num(rows[0]?.c) > perHour) return { granted: false, reason: 'user', notify: false };
  } catch {
    // Both ledgers unusable: let the message through (see the header — a dropped takedown request
    // is worse than a rare unmetered forward, and the webhook's own 20/min guard still applies).
    // eslint-disable-next-line no-console
    console.error('[bot] inbox fallback limiter unavailable');
  }
  return { granted: true, id: null, viaReserve: false };
}

/** Give the slot back when the forward never reached anyone (the person may write again at once). */
async function releaseInboxSlot(sql: Sql, id: string | null): Promise<void> {
  if (!id) return;
  try {
    await sql`delete from bot_inbox where id = ${id}::uuid`;
  } catch {
    // eslint-disable-next-line no-console
    console.error('[bot] inbox slot release failed');
  }
}

/** Best-effort reply to the person; a Bot API failure must never break the webhook. */
async function reply(deps: InboxDeps, chatId: number, text: string): Promise<void> {
  try {
    await deps.send(chatId, text);
  } catch {
    // eslint-disable-next-line no-console
    console.error('[bot] inbox reply failed');
  }
}

/** DM every admin one plain-text message. True when at least ONE of them actually received it. */
async function dmAdmins(sql: Sql, deps: InboxDeps, dm: string): Promise<boolean> {
  let ids: string[] = [];
  try {
    ids = await deps.recipients(sql);
  } catch {
    // eslint-disable-next-line no-console
    console.error('[bot] inbox: admin recipients lookup failed');
  }
  if (ids.length === 0) {
    // eslint-disable-next-line no-console
    console.error('[bot] inbox: no admin recipients configured — message NOT delivered');
    return false;
  }
  let delivered = 0;
  for (const id of ids) {
    try {
      // Two arguments ON PURPOSE: no `extra`, hence no parse_mode — the text is data.
      const r = await deps.send(id, dm);
      if (r?.ok !== false) delivered += 1;
    } catch {
      // eslint-disable-next-line no-console
      console.error('[bot] inbox: admin forward failed');
    }
  }
  return delivered > 0;
}

/** Forward one person's message to the admins. True when at least ONE of them received it. */
async function forwardToAdmins(
  sql: Sql,
  sender: InboxSender,
  text: string,
  truncated: boolean,
  deps: InboxDeps,
): Promise<boolean> {
  return dmAdmins(sql, deps, adminInboxText(sender, text, truncated));
}

/**
 * Tell the owner that the global 24h window is exhausted — ONCE per window (007 M1(б)).
 *
 * The "once" is claimed the same way a forward slot is: an insert that only happens when no
 * 'alert' row exists inside the window. 0 rows = somebody (another invocation, an earlier message)
 * already warned — stay quiet. The marker is KEPT even when no admin could be reached: retrying on
 * every blocked message would turn the warning itself into the flood it is meant to report.
 *
 * The marker row uses from_id = 0 (no Telegram account has that id) and forwarded = false, so it
 * can never be mistaken for somebody's forward or for their "already answered" note.
 */
async function alertGlobalCeiling(
  sql: Sql,
  deps: InboxDeps,
  perDay: number,
  reserve: number,
): Promise<void> {
  // perDay = 0 is the documented EMERGENCY STOP, i.e. a deliberate owner action — not an incident.
  if (perDay <= 0) return;
  let claimed: unknown[];
  try {
    claimed = await sql`
      insert into bot_inbox (from_id, chat_id, update_id, text_len, forwarded, kind)
      select 0::bigint, null::bigint, null::bigint, null::int, false, 'alert'
      where not exists (
        select 1 from bot_inbox
        where kind = 'alert' and created_at > now() - interval '24 hours')
      returning id`;
  } catch (err) {
    // Pre-draft_0029 schema (no `kind` column) or a DB blip: no alert, but the inbox keeps working.
    // eslint-disable-next-line no-console
    console.error('[bot] inbox ceiling alert skipped:', maskToken(String(err)));
    return;
  }
  if (claimed.length === 0) return; // already warned inside this window
  const delivered = await dmAdmins(sql, deps, globalCeilingAlertText(perDay, reserve));
  if (!delivered) {
    // eslint-disable-next-line no-console
    console.error('[bot] inbox ceiling alert: no admin received it');
  }
}

/**
 * Handle one plain private message: rate-limit → forward to the admins → answer the person.
 * Never throws. Returns what happened (used by tests and by future logging).
 */
export async function handleInboxMessage(
  sql: Sql,
  msg: InboxMessage,
  deps: InboxDeps = defaultDeps,
): Promise<InboxOutcome> {
  const { text, truncated } = clampInboxText(msg.text);
  const copy = INBOX_COPY[inboxLocale(msg.sender.lang)];

  // Whole non-negative numbers only: the config is hand-edited, and a fractional value would make
  // the `::int` cast in the claim statement fail (→ needless degraded mode).
  const perHour = whole(await getConfigNumber('user_inbox_per_hour', USER_INBOX_PER_HOUR_DEFAULT));
  const perDay = whole(await getConfigNumber('inbox_global_per_day', INBOX_GLOBAL_PER_DAY_DEFAULT));
  // The newcomer reserve sits ON TOP of a live global ceiling. With inbox_global_per_day = 0 (the
  // documented emergency stop) it is forced to 0 too, so "forward nothing" really means nothing.
  const reserve =
    perDay > 0
      ? whole(
          await getConfigNumber(
            'inbox_newcomer_reserve_per_day',
            INBOX_NEWCOMER_RESERVE_PER_DAY_DEFAULT,
          ),
        )
      : 0;

  const claim = await claimInboxSlot(sql, msg, text.length, perHour, perDay, reserve);
  if (!claim.granted) {
    if (claim.notify) await reply(deps, msg.chatId, claim.reason === 'global' ? copy.busy : copy.throttled);
    // The global window is full AND the reserve did not save this message — the owner must learn
    // that his channel is losing messages. Metered to once per window; the person was answered first.
    if (claim.reason === 'global') await alertGlobalCeiling(sql, deps, perDay, reserve);
    return claim.reason === 'global' ? 'busy' : 'throttled';
  }

  const delivered = await forwardToAdmins(sql, msg.sender, text, truncated, deps);
  if (!delivered) {
    // Nobody got it — do not claim the person's hourly slot and do not pretend we did.
    await releaseInboxSlot(sql, claim.id);
    await reply(deps, msg.chatId, copy.undelivered);
    return 'undelivered';
  }

  await reply(deps, msg.chatId, truncated ? `${copy.ack}\n\n${copy.truncated}` : copy.ack);
  // This one got through only because it was somebody's FIRST message of the day: the global window
  // is already full, so the same warning is due (same once-per-window marker as the blocked path).
  if (claim.viaReserve) await alertGlobalCeiling(sql, deps, perDay, reserve);
  return 'forwarded';
}
