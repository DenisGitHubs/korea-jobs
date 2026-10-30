// lib/korea/bot/webhook.reply.test.ts
//
// «Ответить через бота» (bot/admin-reply.ts) as it is wired into the webhook. The admin replies to
// the bot's «✉️ Написали в бот» DM; the bot sends that text to the person and tells the admin how
// it went. Pinned here:
//   * an admin's reply reaches the person (plain text, no extra) and the admin gets «✅ Отправлено»;
//   * it never enters the inbox (no bot_inbox row, no forward to the admins);
//   * a NON-admin replying to the same text relays nothing;
//   * a reply to something that is not OUR bot's inbox DM is not a relay;
//   * 403 / 429 / other refusals / transport faults → a plain-words note to the admin;
//   * media, edits → a hint, nothing reaches the person;
//   * a forged «· id» in the display name cannot redirect the answer;
//   * the log carries a label only — no text, no id.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SECRET = 'webhook-reply-secret';
/** Fake token: the numeric prefix is the bot id. Not a real credential. */
const BOT_ID = 424242;
const FAKE_TOKEN = `${BOT_ID}:test-only-not-a-token`;
const ADMIN = 999;
const PERSON = 555;

type SendResult = { ok: boolean; error_code?: number; parameters?: { retry_after?: number } };

const h = vi.hoisted(() => {
  const state = {
    isAdmin: true,
    /** What sendMessage answers for a given chat; throw = transport fault. */
    sendTo: (() => ({ ok: true })) as (chatId: number | string) => SendResult | 'throw',
    sent: [] as { chatId: number | string; text: string; argc: number; extra: unknown }[],
    queries: [] as string[],
    values: [] as unknown[][],
  };
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    state.queries.push(q);
    state.values.push(values);
    if (q.includes('insert into bot_updates')) return Promise.resolve([{ update_id: 1 }]);
    if (q.includes('from bot_updates')) return Promise.resolve([{ c: 0 }]);
    if (q.includes('insert into bot_inbox') && q.includes('select')) {
      return Promise.resolve([{ id: '11111111-2222-3333-4444-555555555555', kind: 'message' }]);
    }
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('../config.js', () => ({
  getConfigNumber: async (_k: string, fb: number) => fb,
  getConfigString: async (_k: string, fb: string) => fb,
  getConfigBool: async (_k: string, fb: boolean) => fb,
  getConfigStringArray: async (_k: string, fb: string[]) => fb,
}));
vi.mock('../admin/auth.js', () => ({
  isAdminTelegram: async () => h.state.isAdmin,
  adminRecipients: async () => [String(ADMIN)],
}));
vi.mock('../admin/stats.js', () => ({ gatherStats: async () => ({}), renderStats: () => 'СТАТИСТИКА' }));
vi.mock('../ads/rw.js', () => ({ moderateAd: async () => ({ found: true }) }));
vi.mock('./telegram.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    // botIdFromToken stays REAL: «written by OUR bot» is part of what this file tests.
    botIdFromToken: actual.botIdFromToken,
    sendMessage: (...args: unknown[]) => {
      h.state.sent.push({ chatId: args[0] as number, text: args[1] as string, argc: args.length, extra: args[2] });
      const r = h.state.sendTo(args[0] as number);
      if (r === 'throw') return Promise.reject(new Error('tgCall sendMessage failed: AbortError'));
      return Promise.resolve(r);
    },
    answerCallbackQuery: () => Promise.resolve({ ok: true }),
    editMessageText: () => Promise.resolve({ ok: true }),
    maskToken: (s: string) => s,
    getFile: () => Promise.resolve({ ok: false }),
    downloadFile: () => Promise.reject(new Error('unused')),
  };
});

import { botWebhook } from './webhook.js';
import { adminInboxText, inboxAckText } from './inbox.js';
import { ADMIN_REPLY_COPY, ADMIN_REPLY_PREFIX } from './admin-reply.js';
import type { ReqLike, ResLike } from '../core/http.js';

let updateId = 9000;

async function post(body: unknown): Promise<number> {
  const res = {
    _status: 0,
    statusCode: 0,
    setHeader() {},
    end() {
      this._status = this.statusCode;
    },
  } as ResLike & { _status: number };
  const req: ReqLike = { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': SECRET }, body };
  await botWebhook(req, res);
  return res._status;
}

/** The DM the bot sent the admin about PERSON (no username → the swipe hint, no link). */
const DM = adminInboxText({ id: PERSON, firstName: 'Ann' }, 'Уберите мой номер', false);

function botAuthor(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: BOT_ID, is_bot: true, first_name: 'korea_rabota_bot', ...over };
}

/** A private message from `fromId` replying to `replyTo` (defaults: the admin, replying to DM). */
function reply(
  body: Record<string, unknown>,
  opts: { fromId?: number; replyTo?: Record<string, unknown> | null; edited?: boolean } = {},
): unknown {
  const fromId = opts.fromId ?? ADMIN;
  const message = {
    message_id: 70,
    chat: { id: fromId, type: 'private' },
    from: { id: fromId, first_name: 'Denis', language_code: 'ru' },
    ...(opts.replyTo === null
      ? {}
      : { reply_to_message: opts.replyTo ?? { message_id: 60, from: botAuthor(), chat: { id: fromId }, text: DM } }),
    ...body,
  };
  return { update_id: ++updateId, [opts.edited ? 'edited_message' : 'message']: message };
}

const sentTo = (chatId: number) => h.state.sent.filter((s) => Number(s.chatId) === chatId);

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.TG_WEBHOOK_SECRET = SECRET;
  process.env.BOT_TOKEN = FAKE_TOKEN;
  delete process.env.APP_URL;
  h.state.isAdmin = true;
  h.state.sendTo = () => ({ ok: true });
  h.state.sent = [];
  h.state.queries = [];
  h.state.values = [];
  info =vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  delete process.env.BOT_TOKEN;
});

describe('admin reply — the happy path', () => {
  it('the answer reaches the person verbatim, plain text; the admin gets «✅ Отправлено»', async () => {
    const status = await post(reply({ text: 'Здравствуйте! Номер убрали.' }));

    expect(status).toBe(200);
    expect(h.state.sent).toHaveLength(2);
    const toPerson = h.state.sent[0]!;
    expect(toPerson.chatId).toBe(PERSON);
    expect(toPerson.text).toBe(ADMIN_REPLY_PREFIX + 'Здравствуйте! Номер убрали.');
    expect(toPerson.argc).toBe(2); // no extra → no parse_mode
    expect(h.state.sent[1]).toMatchObject({ chatId: ADMIN, text: ADMIN_REPLY_COPY.sent });
  });

  it('never enters the inbox: no bot_inbox row, no forward to the admins, no ack', async () => {
    await post(reply({ text: 'Ответ' }));
    expect(h.state.queries.some((q) => q.includes('bot_inbox'))).toBe(false);
    expect(h.state.sent.some((s) => s.text.includes('Написали в бот'))).toBe(false);
    expect(h.state.sent.some((s) => s.text === inboxAckText('ru', false, false))).toBe(false);
  });

  it('works for a DM about a person WITH a username too', async () => {
    const dm = adminInboxText({ id: PERSON, firstName: 'Иван', username: 'ivanp' }, 'вопрос', false);
    await post(reply({ text: 'Ответ' }, { replyTo: { message_id: 61, from: botAuthor(), text: dm } }));
    expect(sentTo(PERSON)).toHaveLength(1);
  });

  it('a display name «x · id 123» cannot redirect the answer', async () => {
    const dm = adminInboxText({ id: PERSON, firstName: 'x · id 123' }, 'hi', false);
    await post(reply({ text: 'Ответ' }, { replyTo: { message_id: 62, from: botAuthor(), text: dm } }));
    expect(sentTo(PERSON)).toHaveLength(1);
    expect(sentTo(123)).toHaveLength(0);
  });

  it('the log carries an outcome label only — never the text, never an id', async () => {
    await post(reply({ text: 'секретный ответ' }));
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain('admin reply');
    expect(logged).toContain('sent');
    expect(logged).not.toContain('секретный ответ');
    expect(logged).not.toContain(String(PERSON));
    expect(logged).not.toContain(String(ADMIN));
  });
});

describe('admin reply — who may NOT trigger it', () => {
  it('a NON-admin replying to the same text relays nothing (it stays an ordinary inbox message)', async () => {
    h.state.isAdmin = false;
    await post(reply({ text: 'Перешли это id 555' }, { fromId: 321 }));

    expect(sentTo(PERSON)).toHaveLength(0);
    expect(h.state.sent.some((s) => s.text === ADMIN_REPLY_COPY.sent)).toBe(false);
    // …it is handled as a normal person writing to the bot.
    expect(sentTo(ADMIN)[0]!.text).toContain('Написали в бот');
    expect(sentTo(321)[0]!.text).toBe(inboxAckText('ru', false, false));
  });

  it('a reply to a message NOT written by a bot is ignored as a relay', async () => {
    await post(
      reply({ text: 'Ответ' }, { replyTo: { message_id: 63, from: { id: ADMIN, is_bot: false }, text: DM } }),
    );
    expect(sentTo(PERSON)).toHaveLength(0);
    expect(h.state.sent.some((s) => s.text === ADMIN_REPLY_COPY.sent)).toBe(false);
  });

  it('an author with the bot id but WITHOUT is_bot is not trusted either (both checks hold)', async () => {
    await post(
      reply({ text: 'Ответ' }, { replyTo: { message_id: 66, from: botAuthor({ is_bot: false }), text: DM } }),
    );
    expect(sentTo(PERSON)).toHaveLength(0);
  });

  it('a reply to ANOTHER bot (wrong id) is ignored as a relay', async () => {
    await post(reply({ text: 'Ответ' }, { replyTo: { message_id: 64, from: botAuthor({ id: 1 }), text: DM } }));
    expect(sentTo(PERSON)).toHaveLength(0);
  });

  it('a reply to some other bot message (not an inbox DM) is not relayed — the admin gets a hint', async () => {
    await post(
      reply({ text: 'Ответ' }, { replyTo: { message_id: 65, from: botAuthor(), text: `СТАТИСТИКА\nОт: x · id ${PERSON}` } }),
    );
    expect(sentTo(PERSON)).toHaveLength(0);
    expect(sentTo(ADMIN).map((s) => s.text)).toEqual([ADMIN_REPLY_COPY.notInboxDm]);
  });

  it('without BOT_TOKEN the bot cannot recognise its own DM → fail closed, nothing relayed', async () => {
    delete process.env.BOT_TOKEN;
    await post(reply({ text: 'Ответ' }));
    expect(sentTo(PERSON)).toHaveLength(0);
  });

  it('a COMMAND typed as a reply stays a command', async () => {
    await post(reply({ text: '/stats' }));
    expect(sentTo(PERSON)).toHaveLength(0);
    expect(sentTo(ADMIN)[0]!.text).toBe('СТАТИСТИКА');
  });
});

describe('admin reply — failures are told to the admin in plain words', () => {
  it('403: «человек заблокировал бота» + users.is_blocked, like the notify/broadcast workers', async () => {
    h.state.sendTo = (c) => (Number(c) === PERSON ? { ok: false, error_code: 403 } : { ok: true });
    await post(reply({ text: 'Ответ' }));
    expect(sentTo(ADMIN).map((s) => s.text)).toEqual([ADMIN_REPLY_COPY.blocked]);
    expect(ADMIN_REPLY_COPY.blocked).toContain('заблокировал бота');
    const i = h.state.queries.findIndex((q) => q.includes('update users set is_blocked = true where telegram_id'));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(h.state.values[i]).toEqual([PERSON]);
  });

  it('a successful answer does NOT touch is_blocked', async () => {
    await post(reply({ text: 'Ответ' }));
    expect(h.state.queries.some((q) => q.includes('is_blocked'))).toBe(false);
  });

  it('429: says how long Telegram asks to wait', async () => {
    h.state.sendTo = (c) =>
      Number(c) === PERSON ? { ok: false, error_code: 429, parameters: { retry_after: 7 } } : { ok: true };
    await post(reply({ text: 'Ответ' }));
    expect(sentTo(ADMIN)[0]!.text).toBe(ADMIN_REPLY_COPY.rateLimited(7));
  });

  it('any other refusal: the code, no claim of success', async () => {
    h.state.sendTo = (c) => (Number(c) === PERSON ? { ok: false, error_code: 400 } : { ok: true });
    await post(reply({ text: 'Ответ' }));
    expect(sentTo(ADMIN)[0]!.text).toBe(ADMIN_REPLY_COPY.rejected(400));
    expect(sentTo(ADMIN)[0]!.text).toContain('код 400');
  });

  it('transport fault: honest «неизвестно, дошёл ли», warns about a double send', async () => {
    h.state.sendTo = (c) => (Number(c) === PERSON ? 'throw' : { ok: true });
    const status = await post(reply({ text: 'Ответ' }));
    expect(status).toBe(200);
    expect(sentTo(ADMIN)[0]!.text).toBe(ADMIN_REPLY_COPY.unknown);
  });
});

describe('botIdFromToken — the public id prefix of the token, fail-closed', () => {
  it('reads the numeric prefix; anything malformed is null', async () => {
    const { botIdFromToken } = (await vi.importActual('./telegram.js')) as typeof import('./telegram.js');
    expect(botIdFromToken('123456:AAE-x_y')).toBe(123456);
    expect(botIdFromToken('abc:def')).toBeNull();
    expect(botIdFromToken('123456')).toBeNull();
    expect(botIdFromToken('0:x')).toBeNull();
    expect(botIdFromToken('')).toBeNull();
  });
});

describe('admin reply — text only, no edits', () => {
  it('a sticker reply: hint to the admin, nothing to the person', async () => {
    await post(reply({ sticker: { file_id: 'stk' } }));
    expect(sentTo(PERSON)).toHaveLength(0);
    expect(sentTo(ADMIN).map((s) => s.text)).toEqual([ADMIN_REPLY_COPY.notText]);
  });

  it('a photo WITH a caption: hint (the caption alone would mislead), nothing to the person', async () => {
    await post(reply({ photo: [{ file_id: 'p', width: 10, height: 10 }], caption: 'вот фото' }));
    expect(sentTo(PERSON)).toHaveLength(0);
    expect(sentTo(ADMIN).map((s) => s.text)).toEqual([ADMIN_REPLY_COPY.notText]);
    expect(h.state.queries.some((q) => q.includes('bot_inbox'))).toBe(false);
  });

  it('an EDITED reply is not resent; the admin is told why', async () => {
    await post(reply({ text: 'Ответ (исправлено)' }, { edited: true }));
    expect(sentTo(PERSON)).toHaveLength(0);
    expect(sentTo(ADMIN).map((s) => s.text)).toEqual([ADMIN_REPLY_COPY.edited]);
  });

  it('an ordinary admin message with NO reply is unchanged (still an inbox message)', async () => {
    await post(reply({ text: 'просто сообщение' }, { replyTo: null }));
    expect(sentTo(PERSON)).toHaveLength(0);
    expect(sentTo(ADMIN)[0]!.text).toContain('Написали в бот');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round 2 (review)
// ─────────────────────────────────────────────────────────────────────────────

describe('the answer is attached to the person\'s message (« · msg M»)', () => {
  it('new-form DM: reply_parameters with allow_sending_without_reply, still no parse_mode', async () => {
    const dm = adminInboxText({ id: PERSON, firstName: 'Ann' }, 'вопрос', false, 77);
    await post(reply({ text: 'Ответ' }, { replyTo: { message_id: 67, from: botAuthor(), text: dm } }));
    const toPerson = sentTo(PERSON)[0]!;
    expect(toPerson.text).toBe(ADMIN_REPLY_PREFIX + 'Ответ');
    expect(toPerson.extra).toEqual({ reply_parameters: { message_id: 77, allow_sending_without_reply: true } });
    expect(JSON.stringify(toPerson.extra)).not.toContain('parse_mode');
    expect(sentTo(ADMIN)[0]!.text).toBe(ADMIN_REPLY_COPY.sent);
  });

  it('old-form DM (no « · msg»): still reaches the person, just not attached', async () => {
    await post(reply({ text: 'Ответ' }));
    expect(sentTo(PERSON)[0]!.argc).toBe(2);
  });

  it('the person\'s message_id travels from the update into the admin DM', async () => {
    h.state.isAdmin = false;
    await post({
      update_id: ++updateId,
      message: {
        message_id: 314,
        chat: { id: 321, type: 'private' },
        from: { id: 321, first_name: 'Петя' },
        text: 'Уберите номер',
      },
    });
    expect(sentTo(ADMIN)[0]!.text).toContain('От: Петя · id 321 · msg 314\n');
  });
});

describe('refused up front, with a plain reason', () => {
  it('an UNKNOWN «/…» text: told it looks like a command, nothing to the person', async () => {
    await post(reply({ text: '/ответ на вопрос' }));
    expect(sentTo(PERSON)).toHaveLength(0);
    expect(sentTo(ADMIN).map((s) => s.text)).toEqual([ADMIN_REPLY_COPY.command]);
  });

  it('a whitespace-only text: «пустой»', async () => {
    await post(reply({ text: '   ' }));
    expect(sentTo(PERSON)).toHaveLength(0);
    expect(sentTo(ADMIN).map((s) => s.text)).toEqual([ADMIN_REPLY_COPY.empty]);
  });

  it('over 4096 characters: the count in the refusal; exactly 4096 still goes', async () => {
    // The prefix counts toward Telegram's limit, so the admin's own text gets that much less room.
    const room = 4096 - ADMIN_REPLY_PREFIX.length;
    await post(reply({ text: 'a'.repeat(room + 1) }));
    expect(sentTo(PERSON)).toHaveLength(0);
    expect(sentTo(ADMIN)[0]!.text).toBe(ADMIN_REPLY_COPY.tooLong(4097, 4096));
    expect(sentTo(ADMIN)[0]!.text).toContain('4097');

    h.state.sent = [];
    await post(reply({ text: 'a'.repeat(room) }));
    expect(sentTo(PERSON)).toHaveLength(1);
  });

  it('the edit note does not claim the first version went out', () => {
    expect(ADMIN_REPLY_COPY.edited).not.toMatch(/ушл|первым/);
    expect(ADMIN_REPLY_COPY.edited).toContain('правка человеку не отправлена');
  });
});

describe('a reply to the bot\'s OTHER messages (Цензор/Хейтер п.5)', () => {
  it('admin swipes his own «✅ Отправлено»: hint, NOT an inbox message', async () => {
    await post(reply({ text: 'ещё вопрос' }, { replyTo: { message_id: 68, from: botAuthor(), text: ADMIN_REPLY_COPY.sent } }));
    expect(sentTo(ADMIN).map((s) => s.text)).toEqual([ADMIN_REPLY_COPY.notInboxDm]);
    expect(h.state.queries.some((q) => q.includes('bot_inbox'))).toBe(false);
  });

  it('an edit of such a reply is silently ignored', async () => {
    await post(
      reply({ text: 'ещё вопрос' }, { edited: true, replyTo: { message_id: 68, from: botAuthor(), text: ADMIN_REPLY_COPY.sent } }),
    );
    expect(h.state.sent).toHaveLength(0);
    expect(h.state.queries.some((q) => q.includes('bot_inbox'))).toBe(false);
  });

  it('a NON-admin replying to a bot notification is still «написали в бот» (unchanged)', async () => {
    h.state.isAdmin = false;
    await post(
      reply(
        { text: 'А эта вакансия ещё актуальна?' },
        { fromId: 321, replyTo: { message_id: 69, from: botAuthor(), text: 'Новая вакансия: завод в Ансане' } },
      ),
    );
    expect(sentTo(ADMIN)[0]!.text).toContain('Написали в бот');
    expect(sentTo(321)[0]!.text).toBe(inboxAckText('ru', false, false));
  });
});

describe('edits are not new messages (Цензор №2)', () => {
  it('a NON-admin\'s edited message is neither re-forwarded nor re-acknowledged', async () => {
    h.state.isAdmin = false;
    await post(reply({ text: 'Уберите номер (исправлено)' }, { fromId: 321, replyTo: null, edited: true }));
    expect(h.state.sent).toHaveLength(0);
    expect(h.state.queries.some((q) => q.includes('bot_inbox'))).toBe(false);
  });

  it('an admin\'s edited plain message (no reply) is ignored too', async () => {
    await post(reply({ text: 'исправил' }, { replyTo: null, edited: true }));
    expect(h.state.sent).toHaveLength(0);
  });

  it('an edited /post makes no second draft', async () => {
    await post(reply({ text: '/post\nкогда: через 2 часа\n---\nтекст' }, { replyTo: null, edited: true }));
    expect(h.state.sent).toHaveLength(0);
    expect(h.state.queries.some((q) => q.includes('scheduled_posts'))).toBe(false);
  });
});
