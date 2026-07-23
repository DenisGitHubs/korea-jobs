// lib/korea/cooperation/rw.test.ts
//
// cooperationPost — a "Сотрудничество" enquiry now DMs the configured admins after persisting
// the row. DB-free: a fake tagged-template `sql` serves the requester's identity row and
// swallows the INSERT; adminRecipients + sendMessage are mocked. We pin: the endpoint returns
// 200, and each admin gets ONE DM carrying the header, the contact and the enquiry message.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    userRow: { username: 'bob', telegram_id: '123' } as { username: string | null; telegram_id: string | null },
    admins: ['999'] as string[],
    sent: [] as { chatId: number | string; text: string }[],
  };
  const fakeSql = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<unknown[]> => {
    const text = typeof strings === 'string' ? strings : strings.join(' ? ');
    if (text.includes('from users')) return Promise.resolve([state.userRow]);
    return Promise.resolve([]); // insert into cooperation_requests
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('../core/context.js', () => ({
  authenticate: async () => ({
    ok: true,
    user: { id: '00000000-0000-0000-0000-000000000001', telegramId: '123', publicId: 'abc', lang: 'ru', allowsWriteToPm: true, isBlocked: false },
  }),
}));
vi.mock('../admin/auth.js', () => ({ adminRecipients: async () => h.state.admins }));
vi.mock('../bot/telegram.js', () => ({
  sendMessage: (chatId: number | string, text: string) => {
    h.state.sent.push({ chatId, text });
    return Promise.resolve({ ok: true, result: { message_id: 1 } });
  },
}));

import { cooperationPost } from './rw.js';
import type { ReqLike, ResLike } from '../core/http.js';

function makeReq(body: unknown): ReqLike {
  return { method: 'POST', headers: { authorization: 'tma stub' }, body };
}
function makeRes(): ResLike & { _status: number; _body: unknown } {
  return {
    _status: 0,
    _body: undefined,
    statusCode: 0,
    setHeader() {},
    end(b: string) {
      this._status = this.statusCode;
      this._body = JSON.parse(b);
    },
  };
}

beforeEach(() => {
  h.state.userRow = { username: 'bob', telegram_id: '123' };
  h.state.admins = ['999'];
  h.state.sent = [];
});

describe('cooperationPost — admin notify', () => {
  it('returns 200 and DMs each admin with the header, contact and message', async () => {
    const res = makeRes();
    await cooperationPost(makeReq({ message: 'Хотим разместить вакансии оптом' }), res);

    expect(res._status).toBe(200);
    expect(h.state.sent).toHaveLength(1);
    const dm = h.state.sent[0]!;
    expect(dm.chatId).toBe('999');
    expect(dm.text).toContain('Новая заявка на сотрудничество');
    expect(dm.text).toContain('@bob'); // contact derived from the verified identity
    expect(dm.text).toContain('Хотим разместить вакансии оптом'); // the enquiry text, forwarded as-is
  });

  it('falls back to a tg:// contact when the requester has no username', async () => {
    h.state.userRow = { username: null, telegram_id: '123' };
    const res = makeRes();
    await cooperationPost(makeReq({ message: 'Привет' }), res);
    expect(res._status).toBe(200);
    expect(h.state.sent[0]!.text).toContain('tg://user?id=123');
  });

  it('still returns 200 when there are no admins configured (nothing sent)', async () => {
    h.state.admins = [];
    const res = makeRes();
    await cooperationPost(makeReq({ message: 'Привет' }), res);
    expect(res._status).toBe(200);
    expect(h.state.sent).toHaveLength(0);
  });

  it('rejects an empty message with 400 and sends no DM', async () => {
    const res = makeRes();
    await cooperationPost(makeReq({ message: '   ' }), res);
    expect(res._status).toBe(400);
    expect(h.state.sent).toHaveLength(0);
  });
});
