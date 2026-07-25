// lib/korea/notify/cap.ts
//
// PER-USER DAILY CAP on realtime notification DMs (owner, 2026-07-26).
//
// The product promise is stated in LETTERS, not vacancies: "не больше N уведомлений в сутки".
// One notify tick sends at most ONE grouped DM per user (notify/run.ts groups every match of that
// tick into a single message carrying up to notify_group_cap items), so a user with cap = 10 can
// receive up to 10 DMs a day, each still holding up to 6 offers.
//
// NO DEFAULT LIMIT — owner's rule (2026-07-26): «всем без ограничений. Захотят изменить — то
// изменят в настройках кол-во». There is therefore NO default-cap constant in this module and no
// DEFAULT on the column: a person is unlimited until they themselves pick a number.
//
// STORAGE / WIRE CONTRACT
//   subscriptions.notify_daily_cap  integer NULL, no default   (draft_0026_notify_daily_cap.sql)
//     * NULL  -> NO LIMIT (today's behaviour; the state of every row, old and new, until its owner
//                chooses a number — the migration backfills nobody)
//     * 1..500 -> at most that many DMs per Asia/Seoul calendar day
//   POST /api/subscription accepts `notify_daily_cap`:
//     * ABSENT      -> do not change (a client that knows nothing about the field must never
//                      silently lift someone's limit); a BRAND-NEW row is created with NULL,
//                      i.e. no limit
//     * null OR 0   -> "без ограничения" -> stored as NULL
//     * 1..500      -> stored as-is
//     * anything else (non-integer, negative, > 500, string, NaN) -> 400 bad_request
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

/** Values the settings screen offers. Informational for the client contract; the API accepts 1..500. */
export const NOTIFY_DAILY_CAP_CHOICES: readonly (number | null)[] = [5, 10, 20, 50, null];

export type ParsedDailyCap =
  | {
      ok: true;
      /**
       * The value to bind into SQL:
       *   * null -> the field was ABSENT: keep the stored value (on a brand-new row this lands as
       *             SQL NULL = no limit, since the column has no default)
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
