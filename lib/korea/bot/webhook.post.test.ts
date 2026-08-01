// lib/korea/bot/webhook.post.test.ts
//
// The owner's «отложенные публикации» commands as they are actually wired into the webhook:
// /post (text or the caption of a photo), /posts, and the [Запланировать]/[Отмена]/[Отменить]
// inline buttons.
//
// What is pinned here:
//   * the commands are ADMIN-ONLY and INVISIBLE to everyone else — a stranger gets no reply at all
//     (same rule as /stats), and his message is not turned into an admin forward either;
//   * /post NEVER publishes anything: it stores a DRAFT and asks for confirmation;
//   * the branch sits BEFORE the inbox, so a /post never reaches «написали в бот»;
//   * a photo is taken at its LARGEST size and shown in the preview;
//   * confirm/cancel go through the atomic claims (a re-tap says «Уже обработано»).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const SECRET = 'webhook-post-secret';
const SCHED_ID = '0f8c2a1b-3d4e-4f5a-6b7c-8d9e0f1a2b3c';

const h = vi.hoisted(() => {
  const state = {
    isAdmin: true,
    /** rows returned by the draft->active claim ([] = already handled). */
    activate: [] as unknown[],
    /** rows returned by the cancel claim ([] = already handled). */
    cancel: [] as unknown[],
    /** rows returned by the /posts listing. */
    list: [] as unknown[],
    /** null = the photo could not be stored. */
    storedMedia: { id: 'media-1', mime: 'image/jpeg', sizeBytes: 4 } as { id: string } | null,
    storedFileIds: [] as string[],
    sent: [] as { chatId: number | string; text: string; extra: unknown }[],
    toasts: [] as (string | undefined)[],
    edits: [] as { messageId: number; text: string }[],
    queries: [] as string[],
    values: [] as unknown[][],
  };

  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    state.queries.push(q);
    state.values.push(values);
    if (q.includes('insert into bot_updates')) return Promise.resolve([{ update_id: 1 }]);
    if (q.includes('from bot_updates')) return Promise.resolve([{ c: 0 }]);
    if (q.includes('insert into users')) return Promise.resolve([{ id: 'user-1' }]);
    if (q.includes('from cities')) {
      return Promise.resolve([{ slug: 'ansan', name: { ru: 'Ансан' }, aliases: ['ansan', 'ансан'] }]);
    }
    if (q.includes('insert into scheduled_posts')) return Promise.resolve([{ id: SCHED_ID }]);
    if (q.includes("update scheduled_posts set status = 'active'")) return Promise.resolve(state.activate);
    if (q.includes("update scheduled_posts set status = 'cancelled'")) return Promise.resolve(state.cancel);
    if (q.includes('from scheduled_posts')) return Promise.resolve(state.list);
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
  adminRecipients: async () => ['999'],
}));
vi.mock('../admin/stats.js', () => ({ gatherStats: async () => ({}), renderStats: () => 'СТАТИСТИКА' }));
vi.mock('../ads/rw.js', () => ({ moderateAd: async () => ({ found: true }) }));
// The Telegram download is stubbed, but pickLargestPhoto stays REAL — the "largest size" wiring is
// part of what this file tests.
vi.mock('../media/store.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    storeTelegramPhoto: async (_sql: unknown, photo: { fileId: string }) => {
      h.state.storedFileIds.push(photo.fileId);
      return h.state.storedMedia;
    },
  };
});
vi.mock('./telegram.js', () => ({
  sendMessage: (chatId: number | string, text: string, extra?: unknown) => {
    h.state.sent.push({ chatId, text, extra });
    return Promise.resolve({ ok: true, result: { message_id: 1 } });
  },
  answerCallbackQuery: (_id: string, text?: string) => {
    h.state.toasts.push(text);
    return Promise.resolve({ ok: true });
  },
  editMessageText: (_chatId: number | string, messageId: number, text: string) => {
    h.state.edits.push({ messageId, text });
    return Promise.resolve({ ok: true });
  },
  maskToken: (s: string) => s,
  getFile: () => Promise.resolve({ ok: false }),
  downloadFile: () => Promise.reject(new Error('unused')),
}));

import { botWebhook } from './webhook.js';
import type { ReqLike, ResLike } from '../core/http.js';

function makeRes(): ResLike & { _status: number } {
  return {
    _status: 0,
    statusCode: 0,
    setHeader() {},
    end() {
      this._status = this.statusCode;
    },
  };
}

let updateId = 5000;

async function post(body: unknown): Promise<ResLike & { _status: number }> {
  const req: ReqLike = {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': SECRET },
    body,
  };
  const res = makeRes();
  await botWebhook(req, res);
  return res;
}

/** A private message from the owner (admin id 999). */
function msg(text: string, over: Record<string, unknown> = {}): unknown {
  return {
    update_id: ++updateId,
    message: {
      message_id: 7,
      chat: { id: 999, type: 'private' },
      from: { id: 999, first_name: 'Denis', language_code: 'ru' },
      text,
      ...over,
    },
  };
}

/** An inline button press by the owner. */
function callback(data: string): unknown {
  return {
    update_id: ++updateId,
    callback_query: {
      id: 'cb-1',
      from: { id: 999, first_name: 'Denis' },
      message: { message_id: 42, chat: { id: 999, type: 'private' } },
      data,
    },
  };
}

const COMMAND = ['/post', 'когда: через 2 часа', 'город: Ансан', 'работа: завод', '---', 'Нужны рабочие'].join('\n');

beforeEach(() => {
  process.env.TG_WEBHOOK_SECRET = SECRET;
  h.state.isAdmin = true;
  h.state.activate = [
    {
      kind: 'ad',
      start_at: '2026-08-02T00:00:00.000Z',
      interval_minutes: null,
      total_runs: 1,
      notify: true,
    },
  ];
  h.state.cancel = [{ id: SCHED_ID }];
  h.state.list = [];
  h.state.storedMedia = { id: 'media-1' };
  h.state.storedFileIds = [];
  h.state.sent = [];
  h.state.toasts = [];
  h.state.edits = [];
  h.state.queries = [];
  h.state.values = [];
});

// ─────────────────────────────────────────────────────────────────────────────
// /post
// ─────────────────────────────────────────────────────────────────────────────

describe('/post', () => {
  it('stores a DRAFT and asks for confirmation — nothing is published', async () => {
    const res = await post(msg(COMMAND));

    expect(res._status).toBe(200);
    const insert = h.state.queries.find((q) => q.includes('insert into scheduled_posts'))!;
    expect(insert).toContain("'draft'");
    // No card was created: the ads table is not touched by the command at all.
    expect(h.state.queries.some((q) => q.includes('insert into user_ads'))).toBe(false);

    const preview = h.state.sent[0]!;
    expect(preview.chatId).toBe(999);
    expect(preview.text).toContain('Опубликую');
    expect(preview.text).toContain('Город: Ансан'); // resolved through the cities directory
    expect(preview.text).toContain('Фото: нет');
    const kb = (preview.extra as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } })
      .reply_markup.inline_keyboard[0]!;
    expect(kb.map((b) => b.text)).toEqual(['Запланировать', 'Отмена']);
    expect(kb[0]!.callback_data).toBe(`sp:ok:${SCHED_ID}`);
    expect(kb[1]!.callback_data).toBe(`sp:cancel:${SCHED_ID}`);
  });

  it('is invisible to a non-admin: no reply, no draft, and NOT an inbox message either', async () => {
    h.state.isAdmin = false;
    await post(msg(COMMAND));

    expect(h.state.sent).toHaveLength(0);
    expect(h.state.queries.some((q) => q.includes('scheduled_posts'))).toBe(false);
    expect(h.state.queries.some((q) => q.includes('bot_inbox'))).toBe(false);
  });

  it('a bare /post answers with the copy-paste template', async () => {
    await post(msg('/post'));
    expect(h.state.sent[0]!.text).toContain('Отложенная публикация');
    expect(h.state.sent[0]!.text).toContain('когда: завтра 09:00');
    expect(h.state.queries.some((q) => q.includes('insert into scheduled_posts'))).toBe(false);
  });

  it('a malformed command explains itself and stores nothing', async () => {
    await post(msg('/post\nкогда: когда-нибудь\n---\nтекст'));
    expect(h.state.sent[0]!.text).toContain('Не понял «когда');
    expect(h.state.queries.some((q) => q.includes('insert into scheduled_posts'))).toBe(false);
  });

  it('the /post@BotName form works too', async () => {
    await post(msg(COMMAND.replace('/post', '/post@korea_rabota_bot')));
    expect(h.state.sent[0]!.text).toContain('Опубликую');
  });

  it('never reaches the inbox («написали в бот»)', async () => {
    await post(msg(COMMAND));
    expect(h.state.queries.some((q) => q.includes('bot_inbox'))).toBe(false);
  });

  it('a PHOTO with a /post caption is stored at its LARGEST size and shown in the preview', async () => {
    await post(
      msg('', {
        text: undefined,
        caption: COMMAND,
        photo: [
          { file_id: 'small', width: 90, height: 67 },
          { file_id: 'big', width: 1280, height: 960 },
        ],
      }),
    );

    expect(h.state.storedFileIds).toEqual(['big']);
    expect(h.state.sent[0]!.text).toContain('Фото: есть');
  });

  it('a photo that could not be stored still schedules the post, and says so', async () => {
    h.state.storedMedia = null;
    await post(
      msg('', { text: undefined, caption: COMMAND, photo: [{ file_id: 'big', width: 1280, height: 960 }] }),
    );

    expect(h.state.sent[0]!.text).toContain('Фото не сохранилось');
    expect(h.state.sent[1]!.text).toContain('Опубликую');
    expect(h.state.sent[1]!.text).toContain('Фото: нет');
  });

  it('«тип: реклама» previews as a feed-only paid placement', async () => {
    await post(msg(['/post', 'когда: через 2 часа', 'тип: реклама', 'уведомить: да', '---', 'Курсы'].join('\n')));
    expect(h.state.sent[0]!.text).toContain('только в ленте');
    expect(h.state.sent[0]!.text).toContain('Уведомление подписчикам: нет');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The confirmation buttons
// ─────────────────────────────────────────────────────────────────────────────

describe('[Запланировать] / [Отмена]', () => {
  it('confirms once and repeats the plan in words', async () => {
    await post(callback(`sp:ok:${SCHED_ID}`));

    expect(h.state.queries.some((q) => q.includes("update scheduled_posts set status = 'active'"))).toBe(true);
    expect(h.state.toasts).toEqual(['Запланировано']);
    expect(h.state.edits[0]!.text).toContain('Запланировано.');
    expect(h.state.edits[0]!.text).toContain('Опубликую 2 августа, 09:00 (Сеул)');
    expect(h.state.edits[0]!.text).toContain('Уведомление подписчикам: да');
  });

  it('a re-tap (or a replayed callback) changes nothing', async () => {
    h.state.activate = []; // the atomic claim matched no draft row
    await post(callback(`sp:ok:${SCHED_ID}`));

    expect(h.state.toasts).toEqual(['Уже обработано']);
    expect(h.state.edits).toHaveLength(0);
  });

  it('a confirmed PROMO says out loud that nobody gets a DM', async () => {
    h.state.activate = [
      { kind: 'promo', start_at: '2026-08-02T00:00:00.000Z', interval_minutes: null, total_runs: 1, notify: false },
    ];
    await post(callback(`sp:ok:${SCHED_ID}`));
    expect(h.state.edits[0]!.text).toContain('в личку не уйдёт никому');
  });

  it('cancel flips the row and says so', async () => {
    await post(callback(`sp:cancel:${SCHED_ID}`));
    expect(h.state.toasts).toEqual(['Отменено']);
    expect(h.state.edits[0]!.text).toBe('Публикация отменена');
  });

  it('cancelling something already handled is honest about it', async () => {
    h.state.cancel = [];
    await post(callback(`sp:cancel:${SCHED_ID}`));
    expect(h.state.toasts).toEqual(['Уже обработано']);
    expect(h.state.edits[0]!.text).toBe('Уже обработано');
  });

  it('a stranger pressing the button gets only a soft toast and touches nothing', async () => {
    h.state.isAdmin = false;
    await post(callback(`sp:ok:${SCHED_ID}`));

    expect(h.state.toasts).toEqual(['Недоступно']);
    expect(h.state.queries.some((q) => q.includes('scheduled_posts'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /posts
// ─────────────────────────────────────────────────────────────────────────────

describe('/posts', () => {
  const item = {
    id: SCHED_ID,
    kind: 'ad',
    status: 'active',
    title: 'Завод в Ансане',
    next_run_at: '2026-08-02T00:00:00.000Z',
    done_runs: 1,
    total_runs: 5,
    last_error: null,
  };

  it('lists what is still coming, each with its own [Отменить]', async () => {
    h.state.list = [item];
    await post(msg('/posts'));

    expect(h.state.sent[0]!.text).toBe('Запланировано: 1');
    const line = h.state.sent[1]!;
    expect(line.text).toContain('Обычное · «Завод в Ансане»');
    expect(line.text).toContain('Следующая публикация: 2 августа, 09:00 (Сеул)');
    expect(line.text).toContain('Опубликовано: 1 из 5');
    const kb = (line.extra as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } })
      .reply_markup.inline_keyboard[0]!;
    expect(kb[0]).toEqual({ text: 'Отменить', callback_data: `sp:cancel:${SCHED_ID}` });
  });

  it('says plainly when there is nothing', async () => {
    await post(msg('/posts'));
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]!.text).toContain('Ничего не запланировано');
  });

  it('«/posts all» (and «/posts все») also asks for the finished ones', async () => {
    h.state.list = [{ ...item, status: 'done', next_run_at: null, done_runs: 5 }];
    await post(msg('/posts all'));

    // listSchedules binds the `all` flag into the query.
    const listCall = h.state.values[h.state.queries.findIndex((q) => q.includes('from scheduled_posts'))]!;
    expect(listCall).toContain(true);
    expect(h.state.sent[0]!.text).toBe('Публикации: 1');
    // A finished schedule cannot be cancelled -> no button.
    expect(h.state.sent[1]!.extra).toEqual({});

    h.state.queries = [];
    h.state.values = [];
    h.state.sent = [];
    await post(msg('/posts все'));
    const ruCall = h.state.values[h.state.queries.findIndex((q) => q.includes('from scheduled_posts'))]!;
    expect(ruCall).toContain(true);
  });

  it('shows the reason a schedule broke', async () => {
    h.state.list = [{ ...item, status: 'failed', next_run_at: null, last_error: 'connection reset' }];
    await post(msg('/posts all'));
    expect(h.state.sent[1]!.text).toContain('сорвалось');
    expect(h.state.sent[1]!.text).toContain('connection reset');
  });

  it('is invisible to a non-admin', async () => {
    h.state.isAdmin = false;
    await post(msg('/posts'));
    expect(h.state.sent).toHaveLength(0);
  });
});
