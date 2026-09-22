// lib/korea/core/telegram-id.test.ts
//
// The one rule both doors use to decide whether a `sub` may become `${sub}::bigint`.
//
// WHAT THIS IS GUARDING AGAINST, precisely: a sub of 20–25 digits used to pass every
// signature check on both doors, get a day-long pass, and then fail the cast on EVERY
// later request — where Postgres quotes the rejected value into its own message, the
// message travels up as the cause of a 500, and api/index.ts prints cause.message plus a
// stack. The telegram_id that the whole design keeps out of the log would land in the log,
// once per request, on the loudest path there is.
//
// The boundary is therefore tested from BOTH sides, and with no Number() anywhere.

import { describe, it, expect } from 'vitest';
import { PG_BIGINT_MAX, TELEGRAM_ID_MAX_DIGITS, isTelegramIdString } from './telegram-id.js';

describe('isTelegramIdString — the bound is the COLUMN, not 2^53 and not "digits"', () => {
  it('the constants agree with each other', () => {
    expect(PG_BIGINT_MAX).toBe('9223372036854775807');
    expect(TELEGRAM_ID_MAX_DIGITS).toBe(19);
  });

  it('🔴 a real 19-digit id past 2^53 is accepted as an EXACT string', () => {
    // Number('9007199254740993') === 9007199254740992 — a DIFFERENT account, silently.
    expect(isTelegramIdString('9007199254740993')).toBe(true);
    expect(isTelegramIdString('5550001110')).toBe(true);
    expect(isTelegramIdString('1')).toBe(true);
  });

  it('🔴 the exact bigint maximum is accepted; one past it is not', () => {
    expect(isTelegramIdString('9223372036854775807')).toBe(true);
    expect(isTelegramIdString('9223372036854775808')).toBe(false);
    expect(isTelegramIdString('9999999999999999999')).toBe(false); // 19 nines, still over
  });

  it('🔴 twenty digits and more are refused — that cast fails on every request', () => {
    expect(isTelegramIdString('9'.repeat(20))).toBe(false);
    expect(isTelegramIdString('9'.repeat(25))).toBe(false);
    expect(isTelegramIdString('1'.repeat(20))).toBe(false);
  });

  it('anything that is not a decimal string is refused', () => {
    for (const bad of ['', ' 5', '5 ', '-1', '1.0', '1e3', 'abc', '555; drop', '٥٥٥']) {
      expect(isTelegramIdString(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const bad of [5550001, null, undefined, {}, ['5'], true]) {
      expect(isTelegramIdString(bad), String(bad)).toBe(false);
    }
  });

  it('leading zeros are accepted (they cast fine — refusing them is a rule nobody asked for)', () => {
    expect(isTelegramIdString('0555')).toBe(true);
    expect(isTelegramIdString('0'.repeat(19))).toBe(true);
  });
});
