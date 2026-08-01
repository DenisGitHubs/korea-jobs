// lib/korea/bot/webhook.test.ts
//
// Webhook DISPATCH wiring, with the DB, the Bot API and the admin gate faked. The new inbox
// («написали в бот») must reach the admins WITHOUT disturbing anything that already worked, so
// this file pins both sides:
//   * a plain private message  -> admin DM + acknowledgement (plain text, no parse_mode);
//   * a message from a GROUP   -> nothing at all;
//   * /start, /start <ref>, /stats, /broadcast, callback_query, the update_id replay guard and
//     the secret-token gate -> unchanged behaviour.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const SECRET = 'webhook-test-secret';

const h = vi.hoisted(() => {
  const state = {
    /** false = the bot_updates INSERT hits the PK conflict (Telegram replay). */
    fresh: true,
    /** updates from this sender in the last minute (the durable per-sender guard). */
    updatesPerMinute: 0,
    admins: [] as string[],
    isAdmin: false,
    /** rows returned by the inbox claim insert: [] = over a limit. */
    inboxClaim: [{ id: '11111111-2222-3333-4444-555555555555' }] as unknown[],
    /** true = users.acq_source does not exist yet (deploy landed before the migration). */
    noAcqColumn: false,
    sent: [] as { chatId: number | string; text: string; argc: number }[],
    toasts: [] as (string | undefined)[],
    edits: [] as { chatId: number | string; messageId: number; text: string }[],
    queries: [] as string[],
    moderated: [] as { id: string; action: string }[],
  };
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    state.queries.push(q);
    if (state.noAcqColumn && q.includes('acq_source')) {
      return Promise.reject(new Error('column "acq_source" of relation "users" does not exist'));
    }
    if (q.includes('insert into bot_updates')) return Promise.resolve(state.fresh ? [{ update_id: 1 }] : []);
    if (q.includes('from bot_updates')) return Promise.resolve([{ c: state.updatesPerMinute }]);
    if (q.includes('insert into bot_inbox') && q.includes('select')) return Promise.resolve(state.inboxClaim);
    if (q.includes('as notes')) return Promise.resolve([{ user_hour: 99, notes: 0 }]);
    void values;
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('../config.js', () => ({
  getConfigNumber: async (_k: string, fb: number) => fb,
  getConfigString: async (_k: string, fb: string) => fb,
  getConfigBool: async (_k: string, fb: boolean) => fb,
}));
vi.mock('../admin/auth.js', () => ({
  isAdminTelegram: async () => h.state.isAdmin,
  adminRecipients: async () => h.state.admins,
}));
vi.mock('../admin/stats.js', () => ({
  gatherStats: async () => ({ fake: true }),
  renderStats: () => 'СТАТИСТИКА',
}));
vi.mock('../ads/rw.js', () => ({
  moderateAd: async (id: string, action: string) => {
    h.state.moderated.push({ id, action });
    return { found: true };
  },
}));
vi.mock('./telegram.js', () => ({
  sendMessage: (...args: unknown[]) => {
    h.state.sent.push({ chatId: args[0] as string, text: args[1] as string, argc: args.length });
    return Promise.resolve({ ok: true, result: { message_id: 1 } });
  },
  answerCallbackQuery: (_id: string, text?: string) => {
    h.state.toasts.push(text);
    return Promise.resolve({ ok: true });
  },
  editMessageText: (chatId: number | string, messageId: number, text: string) => {
    h.state.edits.push({ chatId, messageId, text });
    return Promise.resolve({ ok: true });
  },
  maskToken: (s: string) => s,
  // The webhook reaches telegram.ts for media too since /post can carry a photo (media/store.ts).
  // These two are never exercised here (this file sends no photos) but MUST exist on the mock:
  // media/store.ts binds them at module load, so a missing export would break importing the webhook.
  getFile: () => Promise.resolve({ ok: false }),
  downloadFile: () => Promise.reject(new Error('not used in this suite')),
}));

import { botWebhook } from './webhook.js';
import { INBOX_COPY } from './inbox.js';
import type { ReqLike, ResLike } from '../core/http.js';

function makeRes(): ResLike & { _status: number; _body: string } {
  return {
    _status: 0,
    _body: '',
    statusCode: 0,
    setHeader() {},
    end(b: string) {
      this._status = this.statusCode;
      this._body = b;
    },
  };
}

function makeReq(body: unknown, secret: string | undefined = SECRET): ReqLike {
  return {
    method: 'POST',
    headers: secret === undefined ? {} : { 'x-telegram-bot-api-secret-token': secret },
    body,
  };
}

let updateId = 1000;
/** A private message update from a normal person. */
function privateMessage(text: string, over: Record<string, unknown> = {}): unknown {
  return {
    update_id: ++updateId,
    message: {
      message_id: 7,
      chat: { id: 555, type: 'private' },
      from: { id: 555, first_name: 'Иван', username: 'ivanp', language_code: 'ru' },
      text,
      ...over,
    },
  };
}

/** The same text, but posted in a group the bot happens to be in. */
function groupMessage(text: string): unknown {
  return {
    update_id: ++updateId,
    message: {
      message_id: 8,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: 555, first_name: 'Иван', username: 'ivanp', language_code: 'ru' },
      text,
    },
  };
}

async function post(body: unknown, secret?: string): Promise<ResLike & { _status: number; _body: string }> {
  const res = makeRes();
  await botWebhook(makeReq(body, secret === undefined ? SECRET : secret), res);
  return res;
}

beforeEach(() => {
  process.env.TG_WEBHOOK_SECRET = SECRET;
  delete process.env.APP_URL;
  h.state.fresh = true;
  h.state.updatesPerMinute = 0;
  h.state.admins = ['999'];
  h.state.isAdmin = false;
  h.state.inboxClaim = [{ id: '11111111-2222-3333-4444-555555555555' }];
  h.state.noAcqColumn = false;
  h.state.sent = [];
  h.state.toasts = [];
  h.state.edits = [];
  h.state.queries = [];
  h.state.moderated = [];
});

// ─────────────────────────────────────────────────────────────────────────────
// The new behaviour: a person writes to the bot
// ─────────────────────────────────────────────────────────────────────────────

describe('webhook — a plain private message reaches the admins', () => {
  it('forwards it and acknowledges the sender', async () => {
    const res = await post(privateMessage('Уберите мой номер из объявления'));

    expect(res._status).toBe(200);
    expect(h.state.sent).toHaveLength(2);

    const dm = h.state.sent[0]!;
    expect(dm.chatId).toBe('999');
    expect(dm.text).toContain('Написали в бот');
    expect(dm.text).toContain('Иван @ivanp · id 555');
    expect(dm.text).toContain('Уберите мой номер из объявления');
    // PLAIN TEXT: sendMessage got exactly (chatId, text) — no `extra`, so no parse_mode.
    expect(dm.argc).toBe(2);

    const ack = h.state.sent[1]!;
    expect(ack.chatId).toBe(555);
    expect(ack.text).toBe(INBOX_COPY.ru.ack);
  });

  it('forwards the CAPTION of a photo (screenshot + «уберите номер»)', async () => {
    await post(privateMessage('', { text: undefined, caption: 'Вот скриншот, уберите номер' }));
    expect(h.state.sent[0]!.text).toContain('Вот скриншот, уберите номер');
  });

  it('ignores media with no caption (nothing to forward, nobody is answered)', async () => {
    await post(privateMessage('', { text: undefined }));
    expect(h.state.sent).toHaveLength(0);
  });

  it('over the rate limit: the person is answered, the admins are NOT disturbed', async () => {
    h.state.inboxClaim = [];
    await post(privateMessage('спам спам спам'));

    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]!.chatId).toBe(555);
    expect(h.state.sent[0]!.text).toBe(INBOX_COPY.ru.throttled);
  });

  it('a message from a GROUP is never forwarded', async () => {
    await post(groupMessage('привет всем'));
    expect(h.state.sent).toHaveLength(0);
    expect(h.state.queries.some((q) => q.includes('bot_inbox'))).toBe(false);
  });

  it('a Telegram REPLAY of the same update forwards nothing (idempotency intact)', async () => {
    h.state.fresh = false;
    await post(privateMessage('дубль'));
    expect(h.state.sent).toHaveLength(0);
  });

  it('a sender past the durable 20-updates-per-minute guard is not dispatched at all', async () => {
    h.state.updatesPerMinute = 999;
    await post(privateMessage('флуд'));
    expect(h.state.sent).toHaveLength(0);
  });

  it('a wrong secret token is 401 and nothing is dispatched', async () => {
    const res = await post(privateMessage('привет'), 'not-the-secret');
    expect(res._status).toBe(401);
    expect(h.state.sent).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: everything that worked before still works
// ─────────────────────────────────────────────────────────────────────────────

describe('webhook — commands are untouched by the inbox', () => {
  it('/start greets and upserts the user (no admin forward)', async () => {
    const res = await post(privateMessage('/start'));

    expect(res._status).toBe(200);
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]!.chatId).toBe(555);
    expect(h.state.sent[0]!.text).toContain('Привет!');
    expect(h.state.queries.some((q) => q.includes('insert into users'))).toBe(true);
    expect(h.state.queries.some((q) => q.includes('bot_inbox'))).toBe(false);
  });

  it('/start <ref-code> still runs the referral-binding upsert', async () => {
    await post(privateMessage('/start a1b2c3d4e5f60718'));
    const upsert = h.state.queries.find((q) => q.includes('insert into users'))!;
    expect(upsert).toContain('referred_by');
    expect(h.state.sent[0]!.text).toContain('Привет!');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Acquisition label: /start ads_ru1 — the SAME campaign link as the Mini App one,
// arriving through the bot (Telegram Ads may open either). Mirrors core/context.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

describe('webhook — /start with a campaign label', () => {
  /** The users upsert this update produced. */
  const upsert = (): string => h.state.queries.find((q) => q.includes('insert into users'))!;

  it('stores the label and still greets the newcomer', async () => {
    await post(privateMessage('/start ads_ru1'));

    expect(upsert()).toContain('acq_source');
    expect(h.state.sent[0]!.text).toContain('Привет!');
  });

  it('writes it on INSERT ONLY — the ON CONFLICT branch never mentions it', async () => {
    await post(privateMessage('/start ads_ru1'));
    const q = upsert();
    expect(q).toMatch(/insert into users \([^)]*acq_source/);
    expect(q.slice(q.indexOf('do update set'))).not.toContain('acq_source');
  });

  it('never binds a referrer — an ad visitor stays out of the referral numbers', async () => {
    await post(privateMessage('/start ads_uz1'));
    expect(upsert()).not.toContain('referred_by');
  });

  it('a malformed label degrades to the plain /start upsert (person still gets in)', async () => {
    await post(privateMessage('/start ads_'));
    expect(upsert()).not.toContain('acq_source');
    expect(h.state.sent[0]!.text).toContain('Привет!');
  });

  it('survives the deploy-before-migrate window (falls back, still greets)', async () => {
    h.state.noAcqColumn = true;
    await post(privateMessage('/start ads_ru1'));

    const inserts = h.state.queries.filter((q) => q.includes('insert into users'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toContain('acq_source');
    expect(inserts[1]).not.toContain('acq_source');
    expect(h.state.sent[0]!.text).toContain('Привет!');
  });
});

describe('webhook — commands are untouched by the inbox (continued)', () => {

  it('/stats answers an admin with the report and nothing to anyone else', async () => {
    h.state.isAdmin = true;
    await post(privateMessage('/stats'));
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]!.text).toBe('СТАТИСТИКА');
  });

  it('/stats stays invisible to a non-admin (no reply, no forward)', async () => {
    await post(privateMessage('/stats'));
    expect(h.state.sent).toHaveLength(0);
  });

  it('/broadcast without a body still prompts the admin (not forwarded as a message)', async () => {
    h.state.isAdmin = true;
    await post(privateMessage('/broadcast'));
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]!.text).toContain('/broadcast <текст рассылки>');
  });

  it('an unknown command stays silent — it is NOT an inbox message', async () => {
    await post(privateMessage('/help'));
    expect(h.state.sent).toHaveLength(0);
    expect(h.state.queries.some((q) => q.includes('bot_inbox'))).toBe(false);
  });

  it('ad moderation via callback_query still works for an admin', async () => {
    h.state.isAdmin = true;
    const res = await post({
      update_id: ++updateId,
      callback_query: {
        id: 'cb1',
        from: { id: 999, first_name: 'Admin' },
        message: { message_id: 12, chat: { id: 999, type: 'private' } },
        data: 'ad:approve:0f8c2a1b-3d4e-4f5a-6b7c-8d9e0f1a2b3c',
      },
    });

    expect(res._status).toBe(200);
    expect(h.state.moderated).toEqual([{ id: '0f8c2a1b-3d4e-4f5a-6b7c-8d9e0f1a2b3c', action: 'approve' }]);
    expect(h.state.toasts).toEqual(['Решение: одобрено']);
    expect(h.state.edits[0]!.text).toBe('Решение: одобрено.');
  });

  it('a non-admin callback gets only the soft toast', async () => {
    await post({
      update_id: ++updateId,
      callback_query: {
        id: 'cb2',
        from: { id: 555, first_name: 'Иван' },
        message: { message_id: 12, chat: { id: 555, type: 'private' } },
        data: 'ad:approve:0f8c2a1b-3d4e-4f5a-6b7c-8d9e0f1a2b3c',
      },
    });
    expect(h.state.toasts).toEqual(['Недоступно']);
    expect(h.state.moderated).toHaveLength(0);
  });
});
