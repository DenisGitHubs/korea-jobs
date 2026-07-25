// lib/korea/notify/cap.test.ts
//
// The two pure rules behind the per-user daily notification cap (owner, 2026-07-26):
//   * parseNotifyDailyCap — the wire contract of POST /api/subscription. The invariant that matters
//     most is the difference between ABSENT (leave the stored limit alone — an older client must not
//     silently lift someone's cap) and an EXPLICIT null/0 ("без ограничения"). Both end up as SQL
//     NULL in the column, so they have to stay tellable apart on the way in.
//   * isOverDailyCap — the send-side decision, in LETTERS (DMs), not vacancies.

import { describe, it, expect } from 'vitest';
import * as cap from './cap.js';
import {
  parseNotifyDailyCap,
  isOverDailyCap,
  NOTIFY_DAILY_CAP_MIN,
  NOTIFY_DAILY_CAP_MAX,
  NOTIFY_DAILY_CAP_UNLIMITED,
  NOTIFY_DAILY_CAP_CHOICES,
} from './cap.js';

describe('parseNotifyDailyCap — absent vs explicit "no limit"', () => {
  it('ABSENT (undefined) yields param=null: keep whatever is stored', () => {
    expect(parseNotifyDailyCap(undefined)).toEqual({ ok: true, param: null });
  });

  it('explicit null means "без ограничения" and yields the 0 sentinel, NOT null', () => {
    // If it yielded null it would be indistinguishable from "absent", and the upsert's
    // keep-on-absent branch would quietly ignore the user's choice.
    expect(parseNotifyDailyCap(null)).toEqual({ ok: true, param: NOTIFY_DAILY_CAP_UNLIMITED });
    expect(NOTIFY_DAILY_CAP_UNLIMITED).toBe(0);
  });

  it('explicit 0 is the same "no limit" choice as null', () => {
    expect(parseNotifyDailyCap(0)).toEqual({ ok: true, param: 0 });
  });
});

describe('parseNotifyDailyCap — accepted values', () => {
  it('accepts every option the settings screen offers (5 / 10 / 20 / 50 / без ограничения)', () => {
    for (const choice of NOTIFY_DAILY_CAP_CHOICES) {
      const parsed = parseNotifyDailyCap(choice);
      expect(parsed.ok, `choice ${String(choice)} must be accepted`).toBe(true);
    }
    expect(parseNotifyDailyCap(5)).toEqual({ ok: true, param: 5 });
    expect(parseNotifyDailyCap(50)).toEqual({ ok: true, param: 50 });
    expect(parseNotifyDailyCap(null)).toEqual({ ok: true, param: 0 });
  });

  it('accepts the whole documented 1..500 window at its edges', () => {
    expect(parseNotifyDailyCap(NOTIFY_DAILY_CAP_MIN)).toEqual({ ok: true, param: 1 });
    expect(parseNotifyDailyCap(NOTIFY_DAILY_CAP_MAX)).toEqual({ ok: true, param: 500 });
  });

  it('10 is just one of the offered numbers, not a built-in default', () => {
    expect(parseNotifyDailyCap(10)).toEqual({ ok: true, param: 10 });
  });
});

describe('NO built-in default: everyone is unlimited until they choose (owner, 2026-07-26)', () => {
  it('the module exports no default-cap constant at all', () => {
    // «Всем без ограничений. Захотят изменить — то изменят в настройках кол-во.» A default constant
    // is exactly how a limit nobody asked for creeps back in (via a fresh row or a cold /me), so its
    // absence is pinned here rather than left to review.
    expect(Object.keys(cap)).not.toContain('DEFAULT_NOTIFY_DAILY_CAP');
  });

  it('an unchosen cap is null, and a null cap never limits anyone', () => {
    // The whole chain for a person who never opened the setting: the field is absent on the wire ->
    // bound as null -> stored as SQL NULL -> read back as null -> the sender lets everything through.
    expect(parseNotifyDailyCap(undefined)).toEqual({ ok: true, param: null });
    expect(isOverDailyCap(1_000, null)).toBe(false);
  });
});

describe('parseNotifyDailyCap — a present-but-malformed value is rejected (400), never fixed up', () => {
  const bad: unknown[] = [
    -1,
    -10,
    501,
    1000,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '10', // a string is not a number, even a numeric-looking one
    '',
    true,
    false,
    [],
    [10],
    {},
    { value: 10 },
  ];
  for (const v of bad) {
    it(`rejects ${JSON.stringify(v) ?? String(v)}`, () => {
      expect(parseNotifyDailyCap(v)).toEqual({ ok: false });
    });
  }
});

describe('isOverDailyCap — the send-side decision', () => {
  it('NO LIMIT (null cap): never over budget, however much was already sent', () => {
    expect(isOverDailyCap(0, null)).toBe(false);
    expect(isOverDailyCap(77, null)).toBe(false); // the live 19.07 peak
    expect(isOverDailyCap(100_000, null)).toBe(false);
  });

  it('under the cap: still allowed', () => {
    expect(isOverDailyCap(0, 10)).toBe(false);
    expect(isOverDailyCap(9, 10)).toBe(false);
  });

  it('AT the cap: the Nth letter was the last one — no more today', () => {
    expect(isOverDailyCap(10, 10)).toBe(true);
    expect(isOverDailyCap(5, 5)).toBe(true);
    expect(isOverDailyCap(1, 1)).toBe(true);
  });

  it('past the cap (a cap lowered mid-day): still blocked, never negative-clamped', () => {
    expect(isOverDailyCap(40, 10)).toBe(true);
  });

  it('a nonsensical cap (0 or negative) degrades to NO LIMIT, never to total silence', () => {
    // Defensive: the API + the DB CHECK both keep this out, but a cap fault must not mute a user.
    expect(isOverDailyCap(0, 0)).toBe(false);
    expect(isOverDailyCap(50, 0)).toBe(false);
    expect(isOverDailyCap(50, -5)).toBe(false);
  });
});
