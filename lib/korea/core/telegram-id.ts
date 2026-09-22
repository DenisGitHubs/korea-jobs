// lib/korea/core/telegram-id.ts
//
// ONE definition of "a telegram_id this project can actually STORE", shared by both
// doors (core/hub-ticket.ts, core/hub-session.ts) so they can never drift apart.
//
// WHY IT IS NARROWER THAN "DIGITS". users.telegram_id is a Postgres `bigint`, and every
// write goes through `${sub}::bigint`. A 20–25 digit string is perfectly good "digits" and
// passes every signature check — and then the CAST fails on EVERY request the holder makes.
// That failure is not quiet: Postgres quotes the rejected value in its message by
// construction ("value out of range for type bigint" / "invalid input syntax ... \"999…\""),
// the message travels up as the cause of a 500, and api/index.ts prints cause.message plus
// the stack. The id we spent the whole design keeping out of the log then lands in the log,
// once per request, on the noisiest possible path.
//
// So the rule is: accept anything a bigint accepts, refuse everything it does not. The
// contract asked us to carry ids past 2^53 (a JavaScript number cannot) — nobody asked us
// to carry ids past the column.
//
// 🔴 NO Number() ANYWHERE IN HERE. Number('9007199254740993') is 9007199254740992 — a
// DIFFERENT person's account, with not one error anywhere. The bound is compared as a
// STRING: equal-length decimal strings compare lexicographically exactly as they compare
// numerically, and shorter-is-smaller is settled by the length test before that.

/** The largest value a Postgres `bigint` column holds. Compared as text, never parsed. */
export const PG_BIGINT_MAX = '9223372036854775807';

/** 19 — the digit count of PG_BIGINT_MAX. Pinned by a test, not restated by hand. */
export const TELEGRAM_ID_MAX_DIGITS = PG_BIGINT_MAX.length;

/**
 * Decimal digits, at most TELEGRAM_ID_MAX_DIGITS of them. The literal `19` is the value of
 * TELEGRAM_ID_MAX_DIGITS (a regex literal cannot interpolate a constant); telegram-id.test.ts
 * pins the two together so a change to one cannot silently outlive the other.
 */
const DIGITS_RE = /^[0-9]{1,19}$/;

/**
 * True when `value` is a decimal string that fits users.telegram_id (`bigint`).
 *
 * Deliberately permissive about leading zeros ('0555'): they cast fine and refusing them
 * would be a new rule nobody asked for. Deliberately strict about everything else.
 */
export function isTelegramIdString(value: unknown): value is string {
  if (typeof value !== 'string' || !DIGITS_RE.test(value)) return false;
  // Fewer digits than the bound => smaller than the bound, whatever the digits are.
  if (value.length < TELEGRAM_ID_MAX_DIGITS) return true;
  // Same length => plain text comparison is the numeric comparison.
  return value <= PG_BIGINT_MAX;
}
