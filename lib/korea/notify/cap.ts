// lib/korea/notify/cap.ts
//
// PER-USER DAILY CAP on realtime notification DMs (owner, 2026-07-26; default changed 2026-10-24).
//
// The product promise is stated in LETTERS, not vacancies: "не больше N уведомлений в сутки".
// One notify tick sends at most ONE grouped DM per user (notify/run.ts groups every match of that
// tick into a single message carrying up to notify_group_cap items), so a user with cap = 10 can
// receive up to 10 DMs a day, each still holding up to 6 offers.
//
// DEFAULT LIMIT = 10 — owner's decision of 2026-10-24. Two people received 153 letters each in
// 3.5 days, so a NEW subscription that has not chosen anything starts at NOTIFY_DAILY_CAP_DEFAULT
// (10) letters a day. «Без ограничения» stays available as an EXPLICIT choice in the settings.
// All 29 subscriptions that existed on 2026-10-24 were set to 10 by a one-off UPDATE (John; the copy
// of the previous values is his) — this module only governs what NEW rows get.
//   SUPERSEDED — the owner's rule of 2026-07-26 «всем без ограничений. Захотят изменить — то изменят
//   в настройках кол-во» (no default constant, no limit until a person picks a number) is no longer in
//   force. It is kept here in words, not deleted, because the column itself still carries NO default
//   (draft_0026) and NULL still means "no limit"; only the value a NEW row is created with changed,
//   and it is set by the one INSERT that creates subscriptions (subscriptions/rw.ts).
//
// LAST LETTER OF THE DAY — owner, 2026-10-24: «вместе с последним письмом по лимиту пиши, что можно
// увеличить лимит в приложении». The letter that uses up a person's cap carries one extra line
// (NOTIFY_LAST_LETTER_NOTE) at its END — never a separate message, which would itself break the cap.
// Only people WITH a cap get it (NULL = no limit = no last letter), and a person who was already at
// the cap before the run gets nothing at all (the letter is never sent, so neither is the line).
//
// STORAGE / WIRE CONTRACT
//   subscriptions.notify_daily_cap  integer NULL, NO column default   (draft_0026_notify_daily_cap.sql)
//     * NULL  -> NO LIMIT (only an explicit «Без ограничения» choice produces it on a new row)
//     * 1..500 -> at most that many DMs per Asia/Seoul calendar day
//   POST /api/subscription accepts `notify_daily_cap`:
//     * ABSENT      -> do not change an EXISTING row (a client that knows nothing about the field must
//                      never silently change someone's limit); a BRAND-NEW row is created with
//                      NOTIFY_DAILY_CAP_DEFAULT (10)
//     * null OR 0   -> "без ограничения" -> stored as NULL
//     * 1..500      -> stored as-is
//     * anything else (non-integer, negative, > 500, string, NaN) -> 400 bad_request
//   GET /api/me reports NOTIFY_DAILY_CAP_DEFAULT for a person with NO subscription row yet, so the
//   settings screen shows the value a first save would store (the client echoes it back on save).
//
// This module is DB-free and pure on purpose: the parsing rule and the "is this user over budget"
// decision are the two things worth unit-testing, and both must read identically in the write path
// (subscriptions/rw.ts), the read path (users/me.ts) and the sender (notify/run.ts).

/** Smallest meaningful cap: at least one DM a day. Below this a user should just turn notify off. */
export const NOTIFY_DAILY_CAP_MIN = 1;

/** Upper bound. 500 is far above the observed live peak (77 DMs/day) — a sanity ceiling, not UX. */
export const NOTIFY_DAILY_CAP_MAX = 500;

/**
 * Sentinel bound to SQL for an EXPLICIT "no limit" choice. SQL NULL cannot carry that meaning here:
 * in the upsert, NULL already means "the field was absent — keep whatever is stored". So the wire
 * value null/0 is normalised to 0 and turned back into a real SQL NULL by `nullif(param, 0)`.
 */
export const NOTIFY_DAILY_CAP_UNLIMITED = 0;

/**
 * What a NEW subscription gets when the person has not chosen anything (owner, 2026-10-24). It lives in
 * code, not as a column DEFAULT: the only INSERT into subscriptions (subscriptions/rw.ts) always names
 * the column, so a DB default would never be consulted — and a second copy of the number in the
 * schema would only be a second place to forget when the owner changes it again.
 */
export const NOTIFY_DAILY_CAP_DEFAULT = 10;

/**
 * The line appended to the letter that uses up the day's cap (owner's wording, 2026-10-24). ONE place.
 * Plain text — notify DMs are sent without parse_mode, so no character in it is markup.
 * The path «Настройки» → «Уведомления» → «Не больше в сутки» must name what the app ACTUALLY shows:
 * cap.test.ts reads the three labels from app/src/i18n/ru.ts and goes red when either side moves.
 */
export const NOTIFY_LAST_LETTER_NOTE =
  'Это последнее уведомление о вакансиях на сегодня. Новые вакансии всё равно в ленте. Изменить или снять ограничение можно бесплатно: «Настройки» → «Уведомления» → «Не больше в сутки».';

/** Bot API sendMessage text limit: 1-4096 characters after entities parsing (plain text here). */
export const TELEGRAM_TEXT_MAX = 4096;

/** Values the settings screen offers. Informational for the client contract; the API accepts 1..500. */
export const NOTIFY_DAILY_CAP_CHOICES: readonly (number | null)[] = [5, 10, 20, 50, null];

export type ParsedDailyCap =
  | {
      ok: true;
      /**
       * The value to bind into SQL:
       *   * null -> the field was ABSENT: keep the stored value (a brand-new row gets
       *             NOTIFY_DAILY_CAP_DEFAULT — subscriptions/rw.ts)
       *   * 0    -> explicit "no limit" -> `nullif(0, 0)` = SQL NULL
       *   * n    -> the chosen cap
       */
      param: number | null;
    }
  | { ok: false };

/**
 * Validate the `notify_daily_cap` field of POST /api/subscription.
 *
 * STRICT on a value that IS present (400 rather than a silent fix-up): the client offers a closed
 * list (5 / 10 / 20 / 50 / без ограничения), so a malformed value can only be a bug or tampering,
 * and quietly rounding it would change how much mail a person gets without them knowing. Absence,
 * by contrast, is legitimate (older clients) and is never an error.
 */
export function parseNotifyDailyCap(v: unknown): ParsedDailyCap {
  if (v === undefined) return { ok: true, param: null }; // absent -> leave alone
  if (v === null) return { ok: true, param: NOTIFY_DAILY_CAP_UNLIMITED }; // explicit "no limit"
  if (typeof v !== 'number' || !Number.isInteger(v)) return { ok: false };
  if (v === NOTIFY_DAILY_CAP_UNLIMITED) return { ok: true, param: NOTIFY_DAILY_CAP_UNLIMITED }; // 0 = "no limit"
  if (v < NOTIFY_DAILY_CAP_MIN || v > NOTIFY_DAILY_CAP_MAX) return { ok: false };
  return { ok: true, param: v };
}

/**
 * True when this user has already used up today's DM budget and must be skipped this tick.
 * A null cap (and, defensively, a non-positive one) means NO LIMIT — the pre-cap behaviour.
 * `lettersToday` counts DELIVERED MESSAGES since Seoul midnight, not delivered vacancies.
 */
export function isOverDailyCap(lettersToday: number, cap: number | null): boolean {
  if (cap === null || cap <= 0) return false;
  return lettersToday >= cap;
}

/**
 * True when the letter about to be sent is the one that USES UP today's cap (the N-th of N), i.e. it
 * must carry NOTIFY_LAST_LETTER_NOTE. Same inputs and same null rule as isOverDailyCap, so the two can
 * never disagree: no cap -> never a last letter; already over -> no letter is sent at all.
 */
export function isLastLetterOfDay(lettersToday: number, cap: number | null): boolean {
  if (cap === null || cap <= 0) return false;
  if (lettersToday >= cap) return false; // over budget: nothing is sent, so there is no "last" one
  return lettersToday + 1 === cap;
}

/**
 * The text of the last letter of the day: the letter, an empty line, the note. The note is never cut;
 * if the body would push the whole past the Bot API limit, the BODY is shortened (with "…") instead —
 * the inline buttons still open every item, so nothing is lost from what the person can reach.
 * Lengths are UTF-16 code units (never fewer than characters, so the limit holds either way), and the
 * cut never leaves a lone high surrogate — half an emoji would make the whole text invalid UTF-8 on
 * the wire and Telegram would reject the letter.
 */
export function withLastLetterNote(body: string): string {
  const sep = '\n\n';
  const room = TELEGRAM_TEXT_MAX - sep.length - NOTIFY_LAST_LETTER_NOTE.length;
  let fitted = body;
  if (body.length > room) {
    let cut = Math.max(0, room - 1);
    const last = body.charCodeAt(cut - 1);
    if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut -= 1; // do not split a surrogate pair
    fitted = body.slice(0, cut) + '…';
  }
  return `${fitted}${sep}${NOTIFY_LAST_LETTER_NOTE}`;
}
