// lib/korea/notify/author.test.ts
//
// notifyAuthorAdDecision — the author-facing DM about an ad's fate. Fully DB-free: the author
// row is served by a fake tagged-template `sql`, and bot/telegram.sendMessage is mocked to a
// spy that records every (chatId, text, extra). We pin the owner's contract:
//   • approved → one DM with an "Открыть" web_app button deep-linking to /feed/<adId>
//   • rejected → one DM carrying the human reason (admin free-text shown verbatim), NO button
//   • pending  → one DM apologising for the manual-review delay, NO button
//   • a re-edit that landed on the SAME status (prevStatus === status) → NOTHING (no re-spam)
//   • an unreachable author (no allows_write_to_pm / is_blocked / missing) → NOTHING is sent

import { describe, it, expect, vi, beforeEach } from 'vitest';

type AuthorRow = { telegram_id: string | null; allows_write_to_pm: boolean | null; is_blocked: boolean | null };

const h = vi.hoisted(() => {
  const state = {
    userRow: null as AuthorRow | null,
    sent: [] as { chatId: number | string; text: string; extra: Record<string, unknown> }[],
  };
  const fakeSql = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<unknown[]> => {
    const text = typeof strings === 'string' ? strings : strings.join(' ? ');
    if (text.includes('from user_ads')) return Promise.resolve(state.userRow ? [state.userRow] : []);
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('../bot/telegram.js', () => ({
  sendMessage: (chatId: number | string, text: string, extra: Record<string, unknown> = {}) => {
    h.state.sent.push({ chatId, text, extra });
    return Promise.resolve({ ok: true, result: { message_id: 1 } });
  },
}));

import { notifyAuthorAdDecision, rejectReasonText } from './author.js';

const AD_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  h.state.userRow = { telegram_id: '555', allows_write_to_pm: true, is_blocked: false };
  h.state.sent = [];
  process.env.APP_URL = 'https://app.example.com';
});

describe('notifyAuthorAdDecision — approved', () => {
  it('DMs the author with an "Открыть" web_app button on /feed/<adId>', async () => {
    await notifyAuthorAdDecision(h.fakeSql as never, AD_ID, 'approved', null);

    expect(h.state.sent).toHaveLength(1);
    const dm = h.state.sent[0]!;
    expect(dm.chatId).toBe('555');
    expect(dm.text).toContain('опубликовано');
    // The button carries a web_app deep-link straight to this ad's feed card.
    const kb = (dm.extra.reply_markup as { inline_keyboard: { text: string; web_app: { url: string } }[][] })
      ?.inline_keyboard;
    expect(kb?.[0]?.[0]?.text).toBe('Открыть');
    expect(kb?.[0]?.[0]?.web_app.url).toBe(`https://app.example.com/feed/${AD_ID}`);
  });

  it('degrades to a text-only notice when APP_URL is unset (no button)', async () => {
    delete process.env.APP_URL;
    await notifyAuthorAdDecision(h.fakeSql as never, AD_ID, 'approved', null);
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]!.extra.reply_markup).toBeUndefined();
  });
});

describe('notifyAuthorAdDecision — rejected', () => {
  it('DMs the author with the human reason and NO button', async () => {
    await notifyAuthorAdDecision(h.fakeSql as never, AD_ID, 'rejected', 'spam');
    expect(h.state.sent).toHaveLength(1);
    const dm = h.state.sent[0]!;
    expect(dm.text).toContain('отклонено');
    expect(dm.text).toContain(rejectReasonText('spam'));
    expect(dm.extra.reply_markup).toBeUndefined();
  });

  it('uses the generic phrase for an unknown/absent reject_reason', async () => {
    await notifyAuthorAdDecision(h.fakeSql as never, AD_ID, 'rejected', 'admin_button');
    expect(h.state.sent[0]!.text).toContain(rejectReasonText('admin_button'));
    expect(rejectReasonText('admin_button')).toBe('Объявление не прошло проверку.');
  });

  it("shows an admin's FREE-TEXT reason verbatim in the DM (mirrors MyAdsTab)", async () => {
    await notifyAuthorAdDecision(h.fakeSql as never, AD_ID, 'rejected', 'Укажите адрес и телефон работодателя');
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]!.text).toContain('Укажите адрес и телефон работодателя');
    expect(h.state.sent[0]!.extra.reply_markup).toBeUndefined();
  });
});

describe('notifyAuthorAdDecision — pending (manual review)', () => {
  it('DMs an apology for the review delay, with NO button', async () => {
    await notifyAuthorAdDecision(h.fakeSql as never, AD_ID, 'pending', null);
    expect(h.state.sent).toHaveLength(1);
    const dm = h.state.sent[0]!;
    expect(dm.text).toContain('ушло на проверку');
    expect(dm.text).toContain('Извини за задержку');
    expect(dm.extra.reply_markup).toBeUndefined();
  });
});

describe('notifyAuthorAdDecision — status transitions', () => {
  it('sends an apology on a REAL transition INTO pending (approved → pending)', async () => {
    await notifyAuthorAdDecision(h.fakeSql as never, AD_ID, 'pending', null, 'approved');
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]!.text).toContain('ушло на проверку');
  });

  it('stays SILENT when the status did not change (pending → pending)', async () => {
    await notifyAuthorAdDecision(h.fakeSql as never, AD_ID, 'pending', null, 'pending');
    expect(h.state.sent).toHaveLength(0);
  });

  it('stays SILENT on a re-edit that stayed approved (approved → approved)', async () => {
    await notifyAuthorAdDecision(h.fakeSql as never, AD_ID, 'approved', null, 'approved');
    expect(h.state.sent).toHaveLength(0);
  });

  it('stays SILENT on a re-edit that stayed rejected (rejected → rejected)', async () => {
    await notifyAuthorAdDecision(h.fakeSql as never, AD_ID, 'rejected', 'spam', 'rejected');
    expect(h.state.sent).toHaveLength(0);
  });

  it('DMs on a real terminal transition (rejected → approved)', async () => {
    await notifyAuthorAdDecision(h.fakeSql as never, AD_ID, 'approved', null, 'rejected');
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]!.text).toContain('опубликовано');
  });
});

describe('notifyAuthorAdDecision — silent paths', () => {
  it('sends NOTHING for a non-announced status (e.g. archived)', async () => {
    await notifyAuthorAdDecision(h.fakeSql as never, AD_ID, 'archived', null);
    expect(h.state.sent).toHaveLength(0);
  });

  it('sends NOTHING to an author who is not PM-writable', async () => {
    h.state.userRow = { telegram_id: '555', allows_write_to_pm: false, is_blocked: false };
    await notifyAuthorAdDecision(h.fakeSql as never, AD_ID, 'approved', null);
    expect(h.state.sent).toHaveLength(0);
  });

  it('sends NOTHING to a blocked author', async () => {
    h.state.userRow = { telegram_id: '555', allows_write_to_pm: true, is_blocked: true };
    await notifyAuthorAdDecision(h.fakeSql as never, AD_ID, 'rejected', 'spam');
    expect(h.state.sent).toHaveLength(0);
  });

  it('sends NOTHING when the author row is missing', async () => {
    h.state.userRow = null;
    await notifyAuthorAdDecision(h.fakeSql as never, AD_ID, 'approved', null);
    expect(h.state.sent).toHaveLength(0);
  });
});

describe('rejectReasonText — mapping', () => {
  it('maps promo-ish reasons to an advertising phrase', () => {
    expect(rejectReasonText('ads')).toContain('рекламу');
    expect(rejectReasonText('agency_promo')).toContain('рекламу');
  });
  it('falls back to a general phrase for null / blank / service tokens', () => {
    expect(rejectReasonText(null)).toBe('Объявление не прошло проверку.');
    expect(rejectReasonText('')).toBe('Объявление не прошло проверку.');
    expect(rejectReasonText('   ')).toBe('Объявление не прошло проверку.');
    expect(rejectReasonText('rejected')).toBe('Объявление не прошло проверку.');
    expect(rejectReasonText('admin_button')).toBe('Объявление не прошло проверку.');
  });
  it("returns an admin's free-text reason verbatim (trimmed)", () => {
    expect(rejectReasonText('Укажите адрес и телефон работодателя')).toBe('Укажите адрес и телефон работодателя');
    expect(rejectReasonText('  лишние пробелы  ')).toBe('лишние пробелы');
  });
});
