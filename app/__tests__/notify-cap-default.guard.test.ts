/**
 * Guard: the default daily cap on notification DMs (owner, 2026-10-24 — a new
 * subscription without an explicit choice gets 10 letters a day).
 *
 * The number lives on the server (NOTIFY_DAILY_CAP_DEFAULT, lib/korea/notify/cap.ts)
 * and is repeated in three client places that cannot import it: the mock's copy,
 * the mock's cold /me, and the onboarding hint that promises it to the person.
 * Each one is held equal to the server constant here, so the next change of the
 * default cannot leave the mock softer than the server or the text promising a
 * number the server no longer applies.
 *
 * Lives in the ROOT vitest set (the app has no test runner of its own).
 */
import { describe, expect, it } from 'vitest';
import { NOTIFY_DAILY_CAP_DEFAULT } from '../../lib/korea/notify/cap';
import { DEFAULT_ME, MOCK_NOTIFY_DAILY_CAP_DEFAULT } from '../src/shared/api/mock/fixtures';
import { handleMock } from '../src/shared/api/mock/server';
import type { Me, Subscription } from '../src/shared/types/api';
import { ru } from '../src/i18n/ru';
import { en } from '../src/i18n/en';

const capOf = (s: Subscription): number | null | undefined => s.notify_daily_cap;

describe('default daily cap — client copies follow the server constant', () => {
  it('the mock copy equals NOTIFY_DAILY_CAP_DEFAULT', () => {
    expect(MOCK_NOTIFY_DAILY_CAP_DEFAULT).toBe(NOTIFY_DAILY_CAP_DEFAULT);
  });

  it('cold /me in the mock reports the default, as lib/korea/users/me.ts does', async () => {
    expect(capOf(DEFAULT_ME.subscription)).toBe(NOTIFY_DAILY_CAP_DEFAULT);
    const me = (await handleMock('GET', '/api/me')) as Me;
    expect(capOf(me.subscription)).toBe(NOTIFY_DAILY_CAP_DEFAULT);
  });

  it('POST /subscription in the mock: absent field -> default on a fresh row, explicit null kept, absent keeps it', async () => {
    // One sequence on purpose: the mock keeps its state at module level.
    const base = { city_slugs: [], work_types: [], notify: true, visa_types: [] };
    const fresh = (await handleMock('POST', '/api/subscription', base)) as Subscription;
    expect(capOf(fresh)).toBe(NOTIFY_DAILY_CAP_DEFAULT);

    const unlimited = (await handleMock('POST', '/api/subscription', { ...base, notify_daily_cap: null })) as Subscription;
    expect(capOf(unlimited)).toBe(null);

    // The explicit «Без ограничения» must survive a save that does not name the field.
    const kept = (await handleMock('POST', '/api/subscription', base)) as Subscription;
    expect(capOf(kept)).toBe(null);

    const twenty = (await handleMock('POST', '/api/subscription', { ...base, notify_daily_cap: 20 })) as Subscription;
    expect(capOf(twenty)).toBe(20);
  });

  it('the onboarding hint names the server default (ru and en)', () => {
    const n = new RegExp(`(^|\\D)${NOTIFY_DAILY_CAP_DEFAULT}(\\D|$)`);
    expect(ru.onb.notifyHint).toMatch(n);
    expect(en.onb.notifyHint).toMatch(n);
  });
});
