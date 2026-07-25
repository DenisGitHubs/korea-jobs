// lib/korea/share/prepare.handler.test.ts
//
// Handler-level coverage for sharePrepare with the DB, auth and the Bot API faked (same pattern as
// ads/rw.test.ts). Pins the two wirings the copy-only unit tests can't:
//   * kind:"app"        -> invite card: button url = the sharer's PLAIN 16-hex ref code, app copy,
//                          "Открыть приложение"; NO vacancy DB read.
//   * body {vacancyId}  -> DEFAULT kind=vacancy (no `kind` field): vacancy DB read, button url =
//                          v<hex>r<code> deep link, vacancy copy, "Открыть вакансию".
// user_id sent to the Bot API is always the AUTHENTICATED telegram_id — never the body.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const REF = 'a1b2c3d4e5f60718'; // 16-hex public_id of the authenticated caller
const TG_ID = 424242;

const h = vi.hoisted(() => {
  const state = {
    tgCalls: [] as { method: string; params: Record<string, unknown> }[],
    vacancyRow: null as Record<string, unknown> | null,
  };
  const fakeSql = (strings: TemplateStringsArray | string, ..._params: unknown[]): Promise<unknown[]> => {
    const text = typeof strings === 'string' ? strings : strings.join(' ? ');
    if (text.includes('from vacancies')) return Promise.resolve(state.vacancyRow ? [state.vacancyRow] : []);
    if (text.includes('from user_ads')) return Promise.resolve([]);
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('../core/context.js', () => ({
  authenticate: async () => ({
    ok: true,
    user: {
      id: '00000000-0000-0000-0000-000000000001',
      telegramId: String(TG_ID),
      publicId: REF,
      lang: 'ru',
      allowsWriteToPm: true,
      isBlocked: false,
    },
  }),
}));
// deep-link falls back to APP_URL when bot/app config is empty -> url becomes "?startapp=<code>".
vi.mock('../config.js', () => ({
  getConfigString: async (_k: string, fb: string) => fb,
  getConfigNumber: async (_k: string, fb: number) => fb,
  getConfigBool: async (_k: string, fb: boolean) => fb,
}));
vi.mock('../bot/telegram.js', () => ({
  tgCall: async (method: string, params: Record<string, unknown>) => {
    h.state.tgCalls.push({ method, params });
    return { ok: true, result: { id: 'prep_123', expiration_date: 1_800_000_000 } };
  },
}));

import { sharePrepare } from './prepare.js';
import type { ReqLike, ResLike } from '../core/http.js';

function fakeReq(body: unknown): ReqLike {
  return { method: 'POST', headers: { authorization: 'tma x' }, body };
}
function fakeRes(): ResLike & { _body: unknown } {
  return {
    _body: undefined,
    statusCode: 0,
    setHeader() {},
    end(payload: string) {
      (this as unknown as { _body: unknown })._body = JSON.parse(payload);
    },
  } as unknown as ResLike & { _body: unknown };
}

beforeEach(() => {
  h.state.tgCalls = [];
  h.state.vacancyRow = null;
  delete process.env.APP_URL;
  delete process.env.REFERRAL_BOT_USERNAME;
  delete process.env.REFERRAL_APP_SHORTNAME;
});

/** The single reply_markup url the handler built. */
function buttonOf(call: { params: Record<string, unknown> }): { text: string; url: string } {
  const result = call.params.result as { reply_markup: { inline_keyboard: { text: string; url: string }[][] } };
  return result.reply_markup.inline_keyboard[0]![0]!;
}

describe('sharePrepare — kind:"app" (invite card)', () => {
  it('mints a prepared message with the invite link + app copy, no vacancy read', async () => {
    const res = fakeRes();
    await sharePrepare(fakeReq({ kind: 'app' }), res);

    expect(res.statusCode).toBe(200);
    expect(res._body).toEqual({ ok: true, preparedMessageId: 'prep_123', expiresAt: 1_800_000_000 });
    // No DB read on the app branch.
    expect(h.state.tgCalls).toHaveLength(1);

    const call = h.state.tgCalls[0]!;
    expect(call.method).toBe('savePreparedInlineMessage');
    // user_id is the AUTHENTICATED telegram_id, as an integer.
    expect(call.params.user_id).toBe(TG_ID);
    expect(call.params.allow_user_chats).toBe(true);
    expect(call.params.allow_bot_chats).toBe(true);
    expect(call.params.allow_group_chats).toBe(true);
    expect(call.params.allow_channel_chats).toBe(true);

    const result = call.params.result as Record<string, unknown>;
    expect(result.type).toBe('photo');
    expect(result.title).toBe('Работа в Корее — вакансии для своих');
    expect(result.description).toBe('Вакансии в Корее, фильтруем подозрительные объявления. Бесплатно.');

    const btn = buttonOf(call);
    expect(btn.text).toBe('Открыть приложение');
    // Invite link = the caller's PLAIN 16-hex ref code (deep-link fell back to ?startapp= form).
    expect(btn.url).toBe(`?startapp=${REF}`);
  });
});

describe('sharePrepare — default kind (no `kind`) is vacancy', () => {
  const VAC_UUID = '0f8c2a1b-3d4e-4f5a-6b7c-8d9e0f1a2b3c';
  const VAC_HEX = '0f8c2a1b3d4e4f5a6b7c8d9e0f1a2b3c';

  it('reads the vacancy and mints a v<hex>r<code> deep link with vacancy copy', async () => {
    h.state.vacancyRow = {
      work_type: 'factory',
      salary_text: '2 500 000 вон',
      city_name: { ru: 'Ансан', en: 'Ansan' },
    };
    const res = fakeRes();
    await sharePrepare(fakeReq({ vacancyId: VAC_UUID }), res);

    expect(res.statusCode).toBe(200);
    expect(res._body).toEqual({ ok: true, preparedMessageId: 'prep_123', expiresAt: 1_800_000_000 });

    const call = h.state.tgCalls[0]!;
    expect(call.params.user_id).toBe(TG_ID);
    const result = call.params.result as Record<string, unknown>;
    expect(result.title).toBe('Завод — вакансия в Корее');
    expect(result.description).toBe('Ансан · 2 500 000 вон');

    const btn = buttonOf(call);
    expect(btn.text).toBe('Открыть вакансию');
    // Vacancy deep link carries the vacancy hex AND the sharer's ref code (attribution survives).
    expect(btn.url).toBe(`?startapp=v${VAC_HEX}r${REF}`);
  });

  it('404s when the vacancy is not found (and does not call the Bot API)', async () => {
    h.state.vacancyRow = null; // neither a vacancy nor an ad
    const res = fakeRes();
    await sharePrepare(fakeReq({ vacancyId: VAC_UUID }), res);

    expect(res.statusCode).toBe(404);
    expect(h.state.tgCalls).toHaveLength(0);
  });

  it('400s a missing/invalid vacancyId on the vacancy path', async () => {
    const res = fakeRes();
    await sharePrepare(fakeReq({}), res); // no kind, no vacancyId

    expect(res.statusCode).toBe(400);
    expect(h.state.tgCalls).toHaveLength(0);
  });
});
