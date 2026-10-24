// lib/korea/notify/cap.test.ts
//
// The two pure rules behind the per-user daily notification cap (owner, 2026-07-26):
//   * parseNotifyDailyCap — the wire contract of POST /api/subscription. The invariant that matters
//     most is the difference between ABSENT (leave the stored limit alone — an older client must not
//     silently lift someone's cap) and an EXPLICIT null/0 ("без ограничения"). Both end up as SQL
//     NULL in the column, so they have to stay tellable apart on the way in.
//   * isOverDailyCap — the send-side decision, in LETTERS (DMs), not vacancies.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// Owner, 2026-10-24 — replaces the 2026-07-26 rule «всем без ограничений» (which was pinned here as
// "the module exports no default-cap constant"): a NEW subscription without a choice starts at 10.
describe('the default for a NEW subscription is 10 (owner, 2026-10-24)', () => {
  it('exports exactly one default, equal to 10, inside the accepted range', () => {
    expect(cap.NOTIFY_DAILY_CAP_DEFAULT).toBe(10);
    expect(cap.NOTIFY_DAILY_CAP_DEFAULT).toBeGreaterThanOrEqual(NOTIFY_DAILY_CAP_MIN);
    expect(cap.NOTIFY_DAILY_CAP_DEFAULT).toBeLessThanOrEqual(NOTIFY_DAILY_CAP_MAX);
    // one of the values the settings screen offers, so the screen can show it as selected
    expect(NOTIFY_DAILY_CAP_CHOICES).toContain(cap.NOTIFY_DAILY_CAP_DEFAULT);
  });

  it('ABSENT still parses to "keep" (param null) — the default is applied by the INSERT only', () => {
    // The default must not leak into the parser: an absent field on an EXISTING row keeps its value.
    expect(parseNotifyDailyCap(undefined)).toEqual({ ok: true, param: null });
  });

  it('an explicit «Без ограничения» (null cap) still never limits anyone', () => {
    expect(isOverDailyCap(1_000, null)).toBe(false);
  });
});

describe('isLastLetterOfDay — the N-th of N letters', () => {
  it('true only for the letter that uses up the cap', () => {
    expect(cap.isLastLetterOfDay(9, 10)).toBe(true);
    expect(cap.isLastLetterOfDay(8, 10)).toBe(false);
    expect(cap.isLastLetterOfDay(0, 1)).toBe(true); // cap = 1: the only letter is the last
  });
  it('false when there is no cap, or when the cap is already used (no letter is sent then)', () => {
    expect(cap.isLastLetterOfDay(9, null)).toBe(false);
    expect(cap.isLastLetterOfDay(0, 0)).toBe(false);
    expect(cap.isLastLetterOfDay(10, 10)).toBe(false);
    expect(cap.isLastLetterOfDay(40, 5)).toBe(false);
  });
  it('never disagrees with isOverDailyCap: a last letter is always one that is still allowed', () => {
    for (const c of [1, 2, 5, 10, 500]) {
      for (let n = 0; n <= c + 2; n++) {
        if (cap.isLastLetterOfDay(n, c)) expect(isOverDailyCap(n, c)).toBe(false);
      }
    }
  });
});

describe('withLastLetterNote — the note at the end of the letter', () => {
  it('letter, empty line, note', () => {
    expect(cap.withLastLetterNote('Новая вакансия: Ансан · Завод')).toBe(
      `Новая вакансия: Ансан · Завод\n\n${cap.NOTIFY_LAST_LETTER_NOTE}`,
    );
  });
  it('never exceeds the Bot API 4096-char limit; the note is never cut, the body is', () => {
    const out = cap.withLastLetterNote('Я'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(cap.TELEGRAM_TEXT_MAX);
    expect(out.endsWith(`\n\n${cap.NOTIFY_LAST_LETTER_NOTE}`)).toBe(true);
    expect(out).toContain('…');
  });
  it('the note itself is plain text that fits comfortably', () => {
    expect(cap.NOTIFY_LAST_LETTER_NOTE.length).toBeLessThan(300);
    expect(cap.NOTIFY_LAST_LETTER_NOTE).toContain('Настройки');
  });
  it('the cut never leaves half of an emoji (a lone surrogate) in front of the "…"', () => {
    const room = cap.TELEGRAM_TEXT_MAX - 2 - cap.NOTIFY_LAST_LETTER_NOTE.length;
    // Place an emoji so that the plain cut at room-1 code units lands BETWEEN its two halves.
    const body = 'a'.repeat(room - 2) + '😀' + 'x'.repeat(5000);
    expect(body.charCodeAt(room - 2)).toBeGreaterThanOrEqual(0xd800); // the high half sits at the cut
    const out = cap.withLastLetterNote(body);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(out.length).toBeLessThanOrEqual(cap.TELEGRAM_TEXT_MAX);
    expect(out.startsWith('a'.repeat(room - 2) + '…')).toBe(true); // emoji dropped whole
    expect(out.endsWith(`\n\n${cap.NOTIFY_LAST_LETTER_NOTE}`)).toBe(true);
    // an emoji that fits whole before the cut is kept whole
    const kept = cap.withLastLetterNote('a'.repeat(room - 3) + '😀' + 'x'.repeat(5000));
    expect(kept.startsWith('a'.repeat(room - 3) + '😀…')).toBe(true);
  });
});

// The note names a path in the app. It must be the path the app ACTUALLY shows, so the three labels
// are read from the very file the settings screen renders them from — app/src/i18n/ru.ts — by key
// inside its own block. Renaming a label on either side turns this red.
describe('NOTIFY_LAST_LETTER_NOTE — the owner’s wording, and the path matches the app', () => {
  const ru = readFileSync(fileURLToPath(new URL('../../../app/src/i18n/ru.ts', import.meta.url)), 'utf8');
  const label = (block: string, key: string): string => {
    const b = new RegExp(`^  ${block}: \\{\\r?\\n([\\s\\S]*?)^  \\},`, 'm').exec(ru);
    if (!b) throw new Error(`block "${block}" not found in app/src/i18n/ru.ts`);
    const k = new RegExp(`^    ${key}: (['"])(.*?)\\1,`, 'm').exec(b[1]!);
    if (!k) throw new Error(`key "${block}.${key}" not found in app/src/i18n/ru.ts`);
    return k[2]!;
  };

  it('says the change is free', () => {
    expect(cap.NOTIFY_LAST_LETTER_NOTE).toContain('бесплатно');
  });

  it('«Настройки» → «Уведомления» → «Не больше в сутки» = tab.settings → settings.notifications → settings.notifyCapTitle', () => {
    const tab = label('tab', 'settings');
    const section = label('settings', 'notifications');
    const capTitle = label('settings', 'notifyCapTitle');
    for (const s of [tab, section, capTitle]) expect(s.length).toBeGreaterThan(0);
    expect(cap.NOTIFY_LAST_LETTER_NOTE).toContain(`«${tab}» → «${section}» → «${capTitle}»`);
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
