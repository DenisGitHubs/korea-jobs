// lib/korea/watchdog/run.ts
//
// SILENCE WATCHDOG — «продукт умер, а мы узнали случайно» больше не повторяется.
//
// WHY (two incidents, both found by accident):
//   * 25.09 → 21.10.2026 — 27 days with no parsing at all. The AI credit ran out; the model call
//     failed every time; and NOTHING in the database recorded it, because ai_usage is written only
//     on SUCCESS. We learned about it when the owner asked why the token spend looked odd.
//   * August 2026 — 15 days dark for the same class of reason.
// The collector has its own stall-watchdog (collector/src/index.ts). The SERVER side had nobody
// watching it. This file is that nobody.
//
// 🔴 ──────────── WHAT THIS WATCHDOG CANNOT SEE (say it out loud, do not let a reader assume) ───
// It runs INSIDE our own serverless function, on the SAME cron tick as the work it watches, and it
// reads the SAME Postgres. Therefore:
//   * it CANNOT catch a DATABASE outage — the kind of failure that took the product down in
//     August. If Postgres is gone, the tick itself does not run, these queries do not answer, and
//     there is nothing to send an alert with;
//   * it CANNOT catch "Vercel stopped calling the cron at all" — no tick, no watchdog;
//   * it CANNOT catch a Telegram-side delivery failure of its own message beyond logging it.
// It catches exactly two things, and only while the database and the tick are alive:
//   (1) the PARSER is silent while there is work; (2) the COLLECTOR is silent.
// Watching the database and the scheduler themselves requires something OUTSIDE this server. That
// is separate work and it is NOT covered here. Do not read this file as "all three are covered".
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// TWO STATES, NEVER MERGED INTO ONE "something is broken". They are fixed in different places, so
// the message has to say WHERE to go:
//   (1) PARSE SILENT — raw messages are waiting (status='pending' > 0) and the parser's AI has not
//       answered successfully for `watchdog_parse_silent_hours` (24). Means: no AI credit / key
//       revoked / model refusing. The signal is `max(ai_usage.called_at) where caller='parser'`,
//       and it is chosen ON PURPOSE over raw_messages.processed_at: during an AI outage the parser
//       still stamps processed_at on rows it skips as 'too_old' WITHOUT calling the model, so
//       processed_at keeps moving and would have hidden exactly the 27-day incident. "No successful
//       call" is the honest signal for "the model is not answering" — ai_usage recording only
//       successes is precisely what makes its ABSENCE meaningful.
//   (2) RAW SILENT — nothing new has been fetched for `watchdog_raw_silent_hours` (6). Means: the
//       collector's host is down or its Telegram session died. Independent of the AI.
// Both can be true at once; then both messages go out, because both need fixing.
//
// NO SPAM. The tick is every 15 minutes: without memory this would send 96 messages a day. The
// state lives in the `config` table (key + jsonb value — no migration needed, the table already has
// exactly the shape this requires): `watchdog_parse_alert_at` / `watchdog_raw_alert_at` hold the ISO
// moment of the last alert for that state, or jsonb null for "no alert standing". A standing alert
// is not repeated for `watchdog_realert_hours` (24), and when a state CLEARS the watchdog sends one
// "ожил" message and resets the key — so the next real breakage alerts immediately again.
//
// PRIVACY / 007: the message and every log line carry NUMBERS and NAMES only — hours, counts,
// threshold names, config keys. Never a telegram id, never a line of anybody's ad text, never the
// value of an environment variable.
//
// RECIPIENT: whoever has role='admin' in the database (in production that is exactly one person,
// the owner). ADMIN_TELEGRAM_IDS does not exist in the production environment, so the DB role is
// the real path; adminRecipients() is the project's single implementation of that lookup. No admin
// found → write one log line and return quietly. The watchdog never throws: it is the LAST step of
// the tick and must not cost the tick anything.

import { getSql } from '../core/db.js';
import { getConfigBool, getConfigNumber } from '../config.js';
import { adminRecipients } from '../admin/auth.js';
import { sendMessage } from '../bot/telegram.js';

/** Master switch, so the owner can silence the watchdog without a deploy. */
export const WATCHDOG_ENABLED_KEY = 'watchdog_enabled';
/** Hours with no SUCCESSFUL parser AI call, while raw is waiting, before state (1) alerts. */
export const PARSE_SILENT_HOURS_KEY = 'watchdog_parse_silent_hours';
/** Hours with no new raw message before state (2) alerts. */
export const RAW_SILENT_HOURS_KEY = 'watchdog_raw_silent_hours';
/** How long a standing alert suppresses repeats of the SAME state. */
export const REALERT_HOURS_KEY = 'watchdog_realert_hours';
/** Where the standing alert for state (1) is remembered. */
export const PARSE_ALERT_AT_KEY = 'watchdog_parse_alert_at';
/** Where the standing alert for state (2) is remembered. */
export const RAW_ALERT_AT_KEY = 'watchdog_raw_alert_at';

/** Owner-assigned thresholds (named BEFORE the work, so they cannot be fitted to the facts). */
export const PARSE_SILENT_HOURS_DEFAULT = 24;
export const RAW_SILENT_HOURS_DEFAULT = 6;
export const REALERT_HOURS_DEFAULT = 24;

export interface WatchdogResult {
  /** True when the parser is silent WHILE there is work waiting. */
  parseSilent: boolean;
  /** True when no new raw message has arrived inside the threshold. */
  rawSilent: boolean;
  /** Messages actually sent this run (alerts + recoveries), across all admins. */
  sent: number;
  /** Which notifications this run decided to make — for the tick's report and the tests. */
  notes: string[];
  /** How many raw messages are waiting to be parsed. */
  pending: number;
}

interface Probe {
  lastParseAi: number | null;
  lastRaw: number | null;
  pending: number;
}

/** Whole hours between `then` and now; null/unknown counts as "forever" (Infinity). */
function hoursSince(then: number | null, nowMs: number): number {
  if (then === null) return Number.POSITIVE_INFINITY;
  return (nowMs - then) / 3_600_000;
}

/** A finite number of hours as a human string; "никогда" when there is no such moment at all. */
function hoursText(h: number): string {
  return Number.isFinite(h) ? `${Math.floor(h)} ч` : 'никогда (ни одной записи)';
}

/** Parse a timestamp that SQL handed us as TEXT (the Neon driver returns date/time objects for
 *  timestamptz columns, and only the ::text form is safe to read — project skill). */
function parseTs(v: unknown): number | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** One round trip for everything the two states need. */
async function probe(sql: ReturnType<typeof getSql>): Promise<Probe> {
  const rows = (await sql`
    select
      (select max(called_at)::text from ai_usage where caller = 'parser') as last_parse_ai,
      (select max(fetched_at)::text from raw_messages)                    as last_raw,
      (select count(*)::int from raw_messages where status = 'pending')   as pending`) as unknown as {
    last_parse_ai: unknown;
    last_raw: unknown;
    pending: unknown;
  }[];
  const r = rows[0];
  return {
    lastParseAi: parseTs(r?.last_parse_ai),
    lastRaw: parseTs(r?.last_raw),
    pending: typeof r?.pending === 'number' ? r.pending : 0,
  };
}

/** Read a stored alert moment straight from the table — NOT through the 60s config cache, so two
 *  ticks in the same warm process can never both decide "no alert is standing". */
async function readAlertAt(sql: ReturnType<typeof getSql>, key: string): Promise<number | null> {
  const rows = (await sql`select value #>> '{}' as v from config where key = ${key}`) as unknown as {
    v: unknown;
  }[];
  return parseTs(rows[0]?.v);
}

/** Remember (or clear, with null) the standing alert for a state. */
async function writeAlertAt(
  sql: ReturnType<typeof getSql>,
  key: string,
  iso: string | null,
): Promise<void> {
  await sql`
    insert into config (key, value) values (${key}, ${JSON.stringify(iso)}::jsonb)
    on conflict (key) do update set value = excluded.value`;
}

/** The alert text for state (1). Numbers and names only. */
export function parseSilentText(silentHours: number, thresholdHours: number, pending: number): string {
  return (
    '⚠️ Разбор вакансий молчит.\n' +
    `Последний успешный ответ ИИ: ${hoursText(silentHours)} назад (порог ${thresholdHours} ч).\n` +
    `В очереди ждёт сообщений: ${pending}.\n` +
    'Сырьё при этом приходит — читалка жива, дело на нашей стороне: смотри баланс ИИ и ключ ' +
    '(переменная ANTHROPIC_API_KEY), затем логи шага parse.'
  );
}

/** The alert text for state (2). Numbers and names only. */
export function rawSilentText(silentHours: number, thresholdHours: number): string {
  return (
    '⚠️ Читалка молчит.\n' +
    `Новое сырьё не приходило: ${hoursText(silentHours)} (порог ${thresholdHours} ч).\n` +
    'Разбор тут не виноват: смотри сервер читалки (collector) и её сессию Telegram.'
  );
}

/** The "it is back" text for either state. */
export function recoveredText(what: 'parse' | 'raw', pending: number): string {
  return what === 'parse'
    ? `✅ Разбор ожил: ИИ снова отвечает. В очереди сейчас: ${pending}.`
    : '✅ Читалка ожила: новое сырьё снова приходит.';
}

/**
 * One pass of the watchdog. Never throws (it is the tick's last step), and sends at most one
 * message per state per run.
 */
export async function runWatchdog(): Promise<WatchdogResult> {
  const result: WatchdogResult = { parseSilent: false, rawSilent: false, sent: 0, notes: [], pending: 0 };
  try {
    if (!(await getConfigBool(WATCHDOG_ENABLED_KEY, true))) {
      result.notes.push('disabled');
      return result;
    }
    const sql = getSql();
    const nowMs = Date.now();

    const parseThreshold = await getConfigNumber(PARSE_SILENT_HOURS_KEY, PARSE_SILENT_HOURS_DEFAULT);
    const rawThreshold = await getConfigNumber(RAW_SILENT_HOURS_KEY, RAW_SILENT_HOURS_DEFAULT);
    const realertHours = await getConfigNumber(REALERT_HOURS_KEY, REALERT_HOURS_DEFAULT);

    const p = await probe(sql);
    result.pending = p.pending;

    const parseSilentFor = hoursSince(p.lastParseAi, nowMs);
    const rawSilentFor = hoursSince(p.lastRaw, nowMs);

    // 🔴 THE TWO STATES ARE JUDGED SEPARATELY. An empty queue is LEGITIMATE SILENCE, not a
    // breakage: with nothing to parse there is nothing for the AI to answer, and alerting on it
    // would teach the owner to ignore the watchdog.
    result.parseSilent = p.pending > 0 && parseSilentFor >= parseThreshold;
    result.rawSilent = rawSilentFor >= rawThreshold;

    const states: {
      key: string;
      active: boolean;
      what: 'parse' | 'raw';
      text: string;
    }[] = [
      {
        key: PARSE_ALERT_AT_KEY,
        active: result.parseSilent,
        what: 'parse',
        text: parseSilentText(parseSilentFor, parseThreshold, p.pending),
      },
      {
        key: RAW_ALERT_AT_KEY,
        active: result.rawSilent,
        what: 'raw',
        text: rawSilentText(rawSilentFor, rawThreshold),
      },
    ];

    const outbox: string[] = [];
    for (const s of states) {
      const standingSince = await readAlertAt(sql, s.key);
      if (s.active) {
        // A standing alert is not repeated until realertHours have passed (96 ticks a day
        // otherwise). A FIRST alert has no standing moment, so it goes out at once.
        if (standingSince === null || hoursSince(standingSince, nowMs) >= realertHours) {
          outbox.push(s.text);
          result.notes.push(standingSince === null ? `${s.what}:alert` : `${s.what}:realert`);
          await writeAlertAt(sql, s.key, new Date(nowMs).toISOString());
        } else {
          result.notes.push(`${s.what}:suppressed`);
        }
      } else if (standingSince !== null) {
        // The state cleared: say so ONCE and forget the alert, so the next breakage alerts at once.
        outbox.push(recoveredText(s.what, p.pending));
        result.notes.push(`${s.what}:recovered`);
        await writeAlertAt(sql, s.key, null);
      }
    }

    if (outbox.length === 0) return result;

    const ids = await adminRecipients(sql);
    if (ids.length === 0) {
      // Quiet exit, but never silent to the log: names and counts only.
      // eslint-disable-next-line no-console
      console.error('[watchdog] no admin recipient (users.role=admin): %d message(s) not sent', outbox.length);
      result.notes.push('no_admin');
      return result;
    }
    for (const id of ids) {
      for (const text of outbox) {
        try {
          await sendMessage(id, text);
          result.sent += 1;
        } catch {
          // A delivery failure must not break the tick, and the reason belongs to the transport's
          // own log — here only the fact, with no id in it.
          // eslint-disable-next-line no-console
          console.error('[watchdog] alert delivery failed');
        }
      }
    }
    return result;
  } catch (err) {
    // Best-effort by contract: a broken watchdog must never cost the tick its real work.
    // eslint-disable-next-line no-console
    console.error('[watchdog] run failed:', err instanceof Error ? err.message : String(err));
    result.notes.push('error');
    return result;
  }
}
