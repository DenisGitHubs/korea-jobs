// lib/korea/bot/inbox.test.ts
//
// The «написали в бот» inbox: copy + the forward/throttle decision. DB-free — a fake tagged-template
// `sql` plays the bot_inbox ledger (the claim insert returns a row or not) and the Bot API + admin
// recipients arrive as INJECTED deps, so we can pin the behaviour the Privacy Policy depends on:
// the message reaches the admins, the person is answered, and a flooder is metered.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ cfg: {} as Record<string, number> }));
// getConfigNumber would hit the config cache → getSql() → a real DB. Serve the test's own numbers.
vi.mock('../config.js', () => ({
  getConfigNumber: async (key: string, fallback: number) => h.cfg[key] ?? fallback,
}));

import {
  INBOX_TEXT_MAX,
  INBOX_COPY,
  INBOX_THROTTLE_LOG_MAX,
  USER_INBOX_PER_HOUR_DEFAULT,
  INBOX_GLOBAL_PER_DAY_DEFAULT,
  INBOX_NEWCOMER_RESERVE_PER_DAY_DEFAULT,
  inboxLocale,
  isInboxText,
  clampInboxText,
  adminInboxText,
  globalCeilingAlertText,
  handleInboxMessage,
  inboxAckText,
  inboxDmSenderId,
  INBOX_DM_HEADER,
  INBOX_REPLY_HINT,
  INBOX_APP_BUTTON,
  INBOX_GUIDE,
  withInboxGuide,
  inboxAckHead,
  inboxDmTarget,
  type InboxDeps,
  type InboxMessage,
} from './inbox.js';
import type { getSql } from '../core/db.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Sql = ReturnType<typeof getSql>;

/** The acknowledgement a person gets when APP_URL is NOT set (the suite default). */
const ACK_RU = inboxAckText('ru', false, false);
const ACK_EN = inboxAckText('en', false, false);
/** First contact of the day: «busy» / «undelivered» carry the guide too (Цензор №1). */
const BUSY_RU = withInboxGuide('ru', INBOX_COPY.ru.busy, false);
const UNDELIVERED_RU = withInboxGuide('ru', INBOX_COPY.ru.undelivered, false);

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('isInboxText — a plain message, never a command', () => {
  it('accepts ordinary text', () => {
    expect(isInboxText('уберите мой номер')).toBe(true);
    expect(isInboxText('  привет  ')).toBe(true);
  });
  it('rejects commands (they keep their old handling / silence)', () => {
    expect(isInboxText('/start')).toBe(false);
    expect(isInboxText('/start abc123')).toBe(false);
    expect(isInboxText('/stats')).toBe(false);
    expect(isInboxText('/broadcast привет')).toBe(false);
    expect(isInboxText('/whatever')).toBe(false);
  });
  it('rejects empty / whitespace-only text (media with no caption)', () => {
    expect(isInboxText('')).toBe(false);
    expect(isInboxText('   \n ')).toBe(false);
  });
});

describe('clampInboxText — hard length cap', () => {
  it('keeps a normal message as-is', () => {
    expect(clampInboxText('  привет  ')).toEqual({ text: 'привет', truncated: false });
  });
  it('cuts at INBOX_TEXT_MAX and flags it', () => {
    const r = clampInboxText('x'.repeat(INBOX_TEXT_MAX + 500));
    expect(r.text).toHaveLength(INBOX_TEXT_MAX);
    expect(r.truncated).toBe(true);
  });
  it('a message exactly at the cap is not marked truncated', () => {
    expect(clampInboxText('x'.repeat(INBOX_TEXT_MAX)).truncated).toBe(false);
  });
});

describe('inboxLocale — cheap language pick (RU default)', () => {
  it('serves EN to en-* only', () => {
    expect(inboxLocale('en')).toBe('en');
    expect(inboxLocale('en-US')).toBe('en');
  });
  it('falls back to RU for everything else', () => {
    expect(inboxLocale('ru')).toBe('ru');
    expect(inboxLocale('ko')).toBe('ru');
    expect(inboxLocale(null)).toBe('ru');
    expect(inboxLocale(undefined)).toBe('ru');
  });
});

describe('adminInboxText — who wrote, how to answer, and the words verbatim', () => {
  it('renders name, @username, id, a t.me reply link and the message', () => {
    const dm = adminInboxText(
      { id: 777, firstName: 'Иван', lastName: 'Петров', username: 'ivanp', lang: 'ru' },
      'Уберите мой номер из объявления',
      false,
    );
    expect(dm).toContain('Написали в бот');
    expect(dm).toContain('От: Иван Петров @ivanp · id 777');
    expect(dm).toContain('Ответить: https://t.me/ivanp');
    expect(dm).toContain('Уберите мой номер из объявления');
  });

  it('without a username: answer by swiping the DM, never a dead tg://user link', () => {
    const dm = adminInboxText({ id: 42, firstName: 'Ann' }, 'hi', false);
    expect(dm).toContain(`Ответить: ${INBOX_REPLY_HINT}`);
    expect(dm).not.toContain('tg://');
  });

  it('with a username: the t.me link AND the same swipe hint', () => {
    const dm = adminInboxText({ id: 777, firstName: 'Иван', username: 'ivanp' }, 'hi', false);
    expect(dm).toContain(`Ответить: https://t.me/ivanp\nили ${INBOX_REPLY_HINT}`);
  });

  it('says «без имени» when Telegram gave neither a name nor a username', () => {
    expect(adminInboxText({ id: 42 }, 'hi', false)).toContain('От: без имени · id 42');
  });

  it('a hostile display name cannot forge header lines (newlines collapsed, length capped)', () => {
    const dm = adminInboxText(
      { id: 5, firstName: 'Злой\nОтветить: https://evil.example\nОт:', username: 'ok_name' },
      'текст',
      false,
    );
    // The whole hostile name is collapsed INTO the "От:" line, so the header keeps exactly one
    // "От:" line and one "Ответить:" line — the fake ones can never start a line of their own.
    expect(dm.match(/^От: /gm)).toHaveLength(1);
    expect(dm.match(/^Ответить: /gm)).toHaveLength(1);
    expect(dm).toContain('Ответить: https://t.me/ok_name');
    expect(dm.split('\n').filter((l) => l.includes('evil.example'))).toHaveLength(1);
  });

  it('ignores a malformed username (never builds a t.me link from it)', () => {
    const dm = adminInboxText({ id: 5, username: 'bad name/../x' }, 'текст', false);
    expect(dm).toContain(`Ответить: ${INBOX_REPLY_HINT}`);
    expect(dm).not.toContain('t.me/');
  });

  it('marks a truncated message', () => {
    expect(adminInboxText({ id: 1 }, 'x', true)).toContain(`обрезано до ${INBOX_TEXT_MAX} символов`);
  });
});

describe('inboxDmSenderId — who the admin is answering (read back from the bot\'s own DM)', () => {
  it('reads the id back from a real DM, with and without a username', () => {
    expect(inboxDmSenderId(adminInboxText({ id: 777, firstName: 'Иван', username: 'ivanp' }, 'x', false))).toBe(777);
    expect(inboxDmSenderId(adminInboxText({ id: 42 }, 'x', true))).toBe(42);
  });

  it('a display name «x · id 123» cannot redirect the answer — the REAL id at the end wins', () => {
    const dm = adminInboxText({ id: 555, firstName: 'x · id 123' }, 'hi', false);
    expect(dm).toContain('От: x · id 123 · id 555');
    expect(inboxDmSenderId(dm)).toBe(555);
  });

  it('a name with newlines + a forged header cannot redirect it either', () => {
    const dm = adminInboxText(
      { id: 555, firstName: `Злой\n\n${INBOX_DM_HEADER}\n\nОт: Админ · id 1\n`, lastName: '· id 2' },
      'hi',
      false,
    );
    expect(inboxDmSenderId(dm)).toBe(555);
  });

  it('a forged «От: … · id N» line inside the person\'s own WORDS is ignored', () => {
    const dm = adminInboxText({ id: 555, firstName: 'Ann' }, `От: Admin · id 1\nОт: x · id 2`, false);
    expect(inboxDmSenderId(dm)).toBe(555);
  });

  it('anything that is not our DM yields null', () => {
    expect(inboxDmSenderId('привет')).toBeNull();
    expect(inboxDmSenderId('⚠️ Обращения в бот: суточный лимит выбран\n\nОт: x · id 5')).toBeNull();
    expect(inboxDmSenderId(`${INBOX_DM_HEADER}\n\nОт: x · id 5 хвост`)).toBeNull();
    expect(inboxDmSenderId(`${INBOX_DM_HEADER}\n\nОт: x · id 0`)).toBeNull();
    expect(inboxDmSenderId(`${INBOX_DM_HEADER}\nОт: x · id 5`)).toBeNull();
  });
});

describe('the acknowledgement guide — where to post a job / offer a partnership', () => {
  it('RU: conditional, «размещение бесплатное», no «проверяем»', () => {
    const t = inboxAckText('ru', false, true);
    expect(t.startsWith(INBOX_COPY.ru.ack + '\n\n')).toBe(true);
    expect(t).toContain('Если вы хотели разместить вакансию или предложить сотрудничество');
    expect(t).toContain('(кнопка ниже)');
    expect(t).toContain('вкладка «Разместить» внизу, размещение бесплатное;');
    expect(t).toContain('сотрудничество и реклама — вкладка «Партнёрам».');
    expect(t).not.toContain('раздел');
    expect(t).toContain('Сообщения в бот в ленте не публикуются.');
    expect(t).not.toMatch(/провер/i);
    expect(t).not.toContain('это бесплатно');
  });

  it('without a button it points at the menu button instead', () => {
    expect(inboxAckText('ru', false, false)).toContain('(кнопка меню рядом с полем ввода)');
    expect(inboxAckText('ru', false, false)).not.toContain('кнопка ниже');
    expect(inboxAckText('en', false, false)).toContain('(the menu button next to the text field)');
    expect(inboxAckText('en', false, false)).not.toContain('button below');
  });

  it('EN mirrors it, free of «review» promises', () => {
    const t = inboxAckText('en', false, true);
    expect(t.startsWith(INBOX_COPY.en.ack + '\n\n')).toBe(true);
    expect(t).toContain('(button below)');
    expect(t).toContain('“Post” tab at the bottom, posting is free');
    expect(t).toContain('the “Partners” tab.');
    expect(t).not.toContain('section');
    expect(t).not.toMatch(/review|verif|check/i);
  });

  it('the «cut» note sits between the thanks and the guide', () => {
    const t = inboxAckText('ru', true, false);
    expect(t).toBe(`${INBOX_COPY.ru.ack}\n\n${INBOX_COPY.ru.truncated}\n\n${INBOX_GUIDE.ru(false)}`);
  });

  it('the tab names are the ones the app really shows (app/src/i18n tab.post / tab.partners)', () => {
    const tabs = (file: string): string => {
      const src = readFileSync(fileURLToPath(new URL(`../../../app/src/i18n/${file}`, import.meta.url)), 'utf8');
      return /\btab: \{[\s\S]*?\}/.exec(src)?.[0] ?? '';
    };
    const ru = tabs('ru.ts');
    const en = tabs('en.ts');
    expect(ru).toContain("post: 'Разместить'");
    expect(ru).toContain("partners: 'Партнёрам'");
    expect(en).toContain("post: 'Post'");
    expect(en).toContain("partners: 'Partners'");
  });
});

describe('copy — the promise matches the Privacy Policy', () => {
  it('the RU acknowledgement names the 3 business days', () => {
    expect(INBOX_COPY.ru.ack).toContain('3 рабочих дней');
    expect(INBOX_COPY.ru.throttled).toContain('3 рабочих дней');
  });
  it('the EN acknowledgement names the same window', () => {
    expect(INBOX_COPY.en.ack).toContain('3 business days');
  });
  it('defaults are the agreed ceilings', () => {
    expect(USER_INBOX_PER_HOUR_DEFAULT).toBe(5);
    expect(INBOX_GLOBAL_PER_DAY_DEFAULT).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleInboxMessage — fake ledger + injected Bot API
// ─────────────────────────────────────────────────────────────────────────────

interface LedgerState {
  /** Rows the claim INSERT returns: [] = over a limit. */
  claim: unknown[];
  /** Rows the once-per-24h "warn the owner" claim returns: [] = somebody already warned. */
  alertClaim: unknown[];
  /** Counters served on the blocked path. */
  userHour: number;
  notes: number;
  /** bot_updates count for the degraded (no bot_inbox) path. */
  updatesLastHour: number;
  /** This sender's forwards in the last 24h (0 = first contact → the guide is shown). */
  dayForwards: number;
  /** Both claims fail (bot_inbox missing) → the bot_updates fallback. */
  claimThrows: boolean;
  /** Only the `kind`-aware statements fail (code deployed before draft_0029). */
  noKindColumn: boolean;
  queries: { q: string; values: unknown[] }[];
  inserts: number;
  deletes: number;
  reserveClaims: number;
  legacyClaims: number;
}

function makeSql(state: LedgerState): Sql {
  const fn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join(' ? ');
    state.queries.push({ q: q.replace(/\s+/g, ' ').trim(), values });
    // The once-per-window alert marker (checked first: it is also an insert...select on bot_inbox).
    if (q.includes("'alert'")) {
      if (state.claimThrows || state.noKindColumn) {
        return Promise.reject(new Error('column "kind" does not exist'));
      }
      return Promise.resolve(state.alertClaim);
    }
    // The first-contact read (decides whether the «where to post» guide is shown).
    if (q.includes('as day_forwards')) {
      if (state.claimThrows) return Promise.reject(new Error('relation "bot_inbox" does not exist'));
      return Promise.resolve([{ day_forwards: state.dayForwards }]);
    }
    // The full (post-0029) claim — the only statement with the counting CTE.
    if (q.includes('with w as')) {
      state.reserveClaims += 1;
      if (state.claimThrows) return Promise.reject(new Error('relation "bot_inbox" does not exist'));
      if (state.noKindColumn) return Promise.reject(new Error('column "kind" does not exist'));
      return Promise.resolve(state.claim);
    }
    if (q.includes('insert into bot_inbox') && q.includes('select')) {
      state.legacyClaims += 1; // the pre-0029 claim
      if (state.claimThrows) return Promise.reject(new Error('relation "bot_inbox" does not exist'));
      return Promise.resolve(state.claim);
    }
    if (q.includes('insert into bot_inbox')) {
      state.inserts += 1;
      return Promise.resolve([]);
    }
    if (q.includes('delete from bot_inbox')) {
      state.deletes += 1;
      return Promise.resolve([]);
    }
    if (q.includes('from bot_updates')) return Promise.resolve([{ c: state.updatesLastHour }]);
    if (q.includes('as notes')) return Promise.resolve([{ user_hour: state.userHour, notes: state.notes }]);
    return Promise.resolve([]);
  };
  return fn as unknown as Sql;
}

function freshState(over: Partial<LedgerState> = {}): LedgerState {
  return {
    claim: [{ id: '11111111-2222-3333-4444-555555555555', kind: 'message' }],
    // Default = a fresh window: nobody has warned the admins yet, so an exhausted ceiling DOES
    // produce the one DM.
    alertClaim: [{ id: 'aaaaaaaa-0000-0000-0000-000000000000' }],
    userHour: 0,
    notes: 0,
    updatesLastHour: 0,
    dayForwards: 0,
    claimThrows: false,
    noKindColumn: false,
    queries: [],
    inserts: 0,
    deletes: 0,
    reserveClaims: 0,
    legacyClaims: 0,
    ...over,
  };
}

interface SentMsg {
  chatId: number | string;
  text: string;
  argc: number;
  extra?: unknown;
}

function makeDeps(
  sent: SentMsg[],
  opts: { admins?: string[]; sendResult?: (chatId: number | string, extra: unknown) => unknown } = {},
): InboxDeps {
  return {
    send: ((...args: unknown[]) => {
      sent.push({ chatId: args[0] as string, text: args[1] as string, argc: args.length, extra: args[2] });
      return Promise.resolve(
        (opts.sendResult?.(args[0] as string, args[2]) ?? { ok: true, result: { message_id: 1 } }) as never,
      );
    }) as InboxDeps['send'],
    recipients: async () => opts.admins ?? ['999'],
  };
}

const msg = (over: Partial<InboxMessage> = {}): InboxMessage => ({
  updateId: 1,
  chatId: 555,
  sender: { id: 555, firstName: 'Иван', username: 'ivanp', lang: 'ru' },
  text: 'Уберите мой номер, пожалуйста',
  ...over,
});

beforeEach(() => {
  h.cfg = {};
  delete process.env.APP_URL;
});

describe('handleInboxMessage — the acknowledgement carries a button to the app', () => {
  it('APP_URL set: the ack has ONE web_app button to it; admin DMs stay plain (no extra)', async () => {
    process.env.APP_URL = 'https://example.test/';
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(freshState()), msg(), makeDeps(sent));

    expect(out).toBe('forwarded');
    expect(sent).toHaveLength(2);
    expect(sent[0]!.argc).toBe(2); // the admin DM — untouched, no extra
    const ack = sent[1]!;
    expect(ack.chatId).toBe(555);
    expect(ack.text).toBe(inboxAckText('ru', false, true));
    expect(ack.extra).toEqual({
      reply_markup: {
        inline_keyboard: [[{ text: INBOX_APP_BUTTON.ru, web_app: { url: 'https://example.test/' } }]],
      },
    });
    // No parse_mode anywhere: the copy is plain text.
    expect(JSON.stringify(ack.extra)).not.toContain('parse_mode');
  });

  it('EN sender: the EN button label and text', async () => {
    process.env.APP_URL = 'https://example.test/';
    const sent: SentMsg[] = [];
    await handleInboxMessage(makeSql(freshState()), msg({ sender: { id: 555, lang: 'en' } }), makeDeps(sent));
    const ack = sent.at(-1)!;
    expect(ack.text).toBe(inboxAckText('en', false, true));
    expect(JSON.stringify(ack.extra)).toContain('Open the app');
  });

  it('APP_URL not set: no button, and the text points at the menu button instead', async () => {
    const sent: SentMsg[] = [];
    await handleInboxMessage(makeSql(freshState()), msg(), makeDeps(sent));
    const ack = sent.at(-1)!;
    expect(ack.argc).toBe(2);
    expect(ack.text).toBe(ACK_RU);
    expect(ack.text).toContain('кнопка меню рядом с полем ввода');
  });

  it('Telegram refuses the button (400): the person still gets the ack, without it', async () => {
    process.env.APP_URL = 'not a url';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent: SentMsg[] = [];
    const deps = makeDeps(sent, {
      sendResult: (_c, extra) => (extra ? { ok: false, error_code: 400 } : { ok: true, result: { message_id: 1 } }),
    });
    const out = await handleInboxMessage(makeSql(freshState()), msg(), deps);

    expect(out).toBe('forwarded');
    expect(sent).toHaveLength(3); // admin DM + refused ack + plain ack
    expect(sent[2]!.argc).toBe(2);
    expect(sent[2]!.text).toBe(ACK_RU);
    spy.mockRestore();
  });

  it('throttled / busy replies carry NO button (only the ack does)', async () => {
    process.env.APP_URL = 'https://example.test/';
    const sent: SentMsg[] = [];
    await handleInboxMessage(makeSql(freshState({ claim: [], userHour: 5 })), msg(), makeDeps(sent));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.argc).toBe(2);
    expect(sent[0]!.text).toBe(INBOX_COPY.ru.throttled);
  });
});

describe('handleInboxMessage — the happy path', () => {
  it('forwards to every admin and acknowledges the sender', async () => {
    const state = freshState();
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(state), msg(), makeDeps(sent, { admins: ['999', '888'] }));

    expect(out).toBe('forwarded');
    // 2 admin DMs + 1 acknowledgement.
    expect(sent).toHaveLength(3);
    expect(sent[0]!.chatId).toBe('999');
    expect(sent[1]!.chatId).toBe('888');
    expect(sent[0]!.text).toContain('Уберите мой номер, пожалуйста');
    expect(sent[0]!.text).toContain('id 555');
    // PLAIN TEXT: sendMessage is called with exactly (chatId, text) — no `extra`, no parse_mode.
    expect(sent[0]!.argc).toBe(2);
    expect(sent[2]!.chatId).toBe(555);
    expect(sent[2]!.text).toBe(ACK_RU);
  });

  it('answers an en-* sender in English', async () => {
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(
      makeSql(freshState()),
      msg({ sender: { id: 555, firstName: 'John', lang: 'en-US' } }),
      makeDeps(sent),
    );
    expect(out).toBe('forwarded');
    expect(sent.at(-1)!.text).toBe(ACK_EN);
  });

  it('cuts an over-long message and tells the sender it was cut', async () => {
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(
      makeSql(freshState()),
      msg({ text: 'ы'.repeat(INBOX_TEXT_MAX + 100) }),
      makeDeps(sent),
    );
    expect(out).toBe('forwarded');
    expect(sent[0]!.text).toContain(`обрезано до ${INBOX_TEXT_MAX} символов`);
    expect(sent[1]!.text).toContain(INBOX_COPY.ru.truncated);
  });
});

describe('handleInboxMessage — anti-spam', () => {
  it('over the per-sender hourly limit: nothing to the admins, ONE polite reply', async () => {
    const state = freshState({ claim: [], userHour: 5, notes: 0 });
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(state), msg(), makeDeps(sent));

    expect(out).toBe('throttled');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(555);
    expect(sent[0]!.text).toBe(INBOX_COPY.ru.throttled);
    expect(state.inserts).toBe(1); // the "already answered" marker
  });

  it('keeps quiet on every FURTHER message of the same hour (no bounce-back flood)', async () => {
    const state = freshState({ claim: [], userHour: 5, notes: 1 });
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(state), msg(), makeDeps(sent));

    expect(out).toBe('throttled');
    expect(sent).toHaveLength(0);
  });

  it('stops writing throttle markers once INBOX_THROTTLE_LOG_MAX is reached', async () => {
    const state = freshState({ claim: [], userHour: 5, notes: INBOX_THROTTLE_LOG_MAX });
    const out = await handleInboxMessage(makeSql(state), msg(), makeDeps([]));
    expect(out).toBe('throttled');
    expect(state.inserts).toBe(0);
  });

  it('the GLOBAL daily ceiling gives the "too many messages right now" reply', async () => {
    // This sender is well under their own hourly limit → the block came from the global window.
    const state = freshState({ claim: [], userHour: 0, notes: 0 });
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(state), msg(), makeDeps(sent));

    expect(out).toBe('busy');
    // The PERSON is answered first; the owner then gets the one-per-window warning (below).
    expect(sent[0]!.chatId).toBe(555);
    expect(sent[0]!.text).toBe(BUSY_RU);
  });

  it('reads both ceilings from config (owner can retune without a deploy)', async () => {
    h.cfg = { user_inbox_per_hour: 1, inbox_global_per_day: 7 };
    const state = freshState();
    await handleInboxMessage(makeSql(state), msg(), makeDeps([]));
    const claim = state.queries.find((e) => e.q.includes('insert into bot_inbox') && e.q.includes('select'))!;
    // ONE statement re-counts both windows, so two racing invocations cannot both pass a full one.
    expect(claim.q).toContain("interval '1 hour'");
    expect(claim.q).toContain("interval '24 hours'");
    // …and it is the CONFIG values that are compared against, not the built-in defaults.
    expect(claim.values).toContain(1);
    expect(claim.values).toContain(7);
  });
});

describe('handleInboxMessage — nothing is silently lost', () => {
  it('no admins configured: the slot is released and the sender is told honestly', async () => {
    const state = freshState();
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(state), msg(), makeDeps(sent, { admins: [] }));

    expect(out).toBe('undelivered');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe(UNDELIVERED_RU);
    expect(state.deletes).toBe(1); // the claimed slot is given back
  });

  it('a Bot API refusal for every admin is NOT reported as accepted', async () => {
    const state = freshState();
    const sent: SentMsg[] = [];
    const deps = makeDeps(sent, { admins: ['999'], sendResult: () => ({ ok: false, error_code: 403 }) });
    const out = await handleInboxMessage(makeSql(state), msg(), deps);

    expect(out).toBe('undelivered');
    expect(sent.at(-1)!.text).toBe(UNDELIVERED_RU);
    expect(state.deletes).toBe(1);
  });

  it('one admin unreachable, another reached → still accepted', async () => {
    const state = freshState();
    const sent: SentMsg[] = [];
    let n = 0;
    const deps = makeDeps(sent, {
      admins: ['999', '888'],
      sendResult: () => (++n === 1 ? { ok: false, error_code: 403 } : { ok: true, result: { message_id: 1 } }),
    });
    const out = await handleInboxMessage(makeSql(state), msg(), deps);

    expect(out).toBe('forwarded');
    expect(state.deletes).toBe(0);
    expect(sent.at(-1)!.text).toBe(ACK_RU);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 007 M1 — the flood must not silence a first-time request, and the owner must be told
// ─────────────────────────────────────────────────────────────────────────────

describe('handleInboxMessage — newcomer reserve (a flooder cannot swallow a takedown request)', () => {
  const claimOf = (state: LedgerState) => state.queries.find((e) => e.q.includes('with w as'))!;

  it('asks for the reserve in the SAME statement: first-time sender OR room in the global window', async () => {
    const state = freshState();
    await handleInboxMessage(makeSql(state), msg(), makeDeps([]));

    const q = claimOf(state).q;
    // "no forward from this sender in 24h" + "the reserve budget is not spent yet"
    expect(q).toContain('user_day = 0');
    expect(q).toContain('reserve_day <');
    expect(q).toContain("kind = 'reserve'");
    // …and it still enforces both original ceilings.
    expect(q).toContain('user_hour <');
    expect(q).toContain('global_day <');
  });

  it('takes the reserve size from config (owner can retune without a deploy)', async () => {
    h.cfg = { inbox_newcomer_reserve_per_day: 7 };
    const state = freshState();
    await handleInboxMessage(makeSql(state), msg(), makeDeps([]));
    // The reserve ceiling is the LAST bound value of the claim.
    expect(claimOf(state).values.at(-1)).toBe(7);
  });

  it('defaults to 30 when the config key is missing', async () => {
    const state = freshState();
    await handleInboxMessage(makeSql(state), msg(), makeDeps([]));
    expect(claimOf(state).values.at(-1)).toBe(INBOX_NEWCOMER_RESERVE_PER_DAY_DEFAULT);
  });

  it('a message that got through ON the reserve is forwarded AND warns the owner', async () => {
    // kind='reserve' = the global window was full and this was the sender's first message today.
    const state = freshState({ claim: [{ id: 'row-1', kind: 'reserve' }] });
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(state), msg(), makeDeps(sent));

    expect(out).toBe('forwarded');
    expect(sent[0]!.chatId).toBe('999'); // the admin got the person's words
    expect(sent[0]!.text).toContain('Уберите мой номер');
    expect(sent[1]!.chatId).toBe(555); // the person got the acknowledgement
    expect(sent[1]!.text).toBe(ACK_RU);
    // …and the owner learns his ceiling is exhausted.
    expect(sent[2]!.chatId).toBe('999');
    expect(sent[2]!.text).toContain('суточный лимит выбран');
  });

  it('EMERGENCY STOP (inbox_global_per_day = 0) also closes the reserve — nothing gets through', async () => {
    h.cfg = { inbox_global_per_day: 0 };
    const state = freshState({ claim: [] });
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(state), msg(), makeDeps(sent));

    expect(claimOf(state).values.at(-1)).toBe(0); // reserve forced to 0 alongside the ceiling
    expect(out).toBe('busy');
    // A deliberate stop is not an incident: the person is answered, the owner is NOT paged.
    expect(sent).toHaveLength(1);
    expect(state.queries.some((e) => e.q.includes("'alert'"))).toBe(false);
  });
});

describe('handleInboxMessage — the owner is told when the ceiling swallows messages', () => {
  it('DMs every admin once and claims the marker with a 24h guard', async () => {
    const state = freshState({ claim: [], userHour: 0, notes: 0 });
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(state), msg(), makeDeps(sent, { admins: ['999', '888'] }));

    expect(out).toBe('busy');
    expect(sent).toHaveLength(3); // busy reply + 2 admin DMs
    expect(sent[1]!.text).toContain('Обращения в бот');
    expect(sent[2]!.chatId).toBe('888');
    // PLAIN TEXT, exactly like a forward: no `extra`, so no parse_mode.
    expect(sent[1]!.argc).toBe(2);

    const alert = state.queries.find((e) => e.q.includes("'alert'"))!;
    expect(alert.q).toContain('not exists');
    expect(alert.q).toContain("interval '24 hours'");
    expect(alert.q).toContain('from_id'); // written into the same ledger, from_id 0
  });

  it('stays quiet for the rest of the window (the marker is already there)', async () => {
    const state = freshState({ claim: [], alertClaim: [] });
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(state), msg(), makeDeps(sent));

    expect(out).toBe('busy');
    expect(sent).toHaveLength(1); // only the polite reply to the person
    expect(sent[0]!.text).toBe(BUSY_RU);
  });

  it('never fires for a PER-SENDER throttle (that is normal, not an incident)', async () => {
    const state = freshState({ claim: [], userHour: 5, notes: 0 });
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(state), msg(), makeDeps(sent));

    expect(out).toBe('throttled');
    expect(sent).toHaveLength(1);
    expect(state.queries.some((e) => e.q.includes("'alert'"))).toBe(false);
  });

  it('the warning text is plain, numeric and free of personal data', () => {
    const t = globalCeilingAlertText(200, 30);
    expect(t).toContain('200');
    expect(t).toContain('30');
    expect(t).toContain('inbox_global_per_day'); // how to raise it
    expect(t).toContain('не чаще одного раза в сутки');
  });
});

describe('handleInboxMessage — pre-draft_0029 schema (no `kind` column yet)', () => {
  it('retries the old claim and still forwards the message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = freshState({ noKindColumn: true });
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(state), msg(), makeDeps(sent));

    expect(out).toBe('forwarded');
    expect(state.reserveClaims).toBe(1);
    expect(state.legacyClaims).toBe(1); // fell back to the pre-0029 statement
    expect(sent[0]!.text).toContain('Уберите мой номер');
    expect(sent[1]!.text).toBe(ACK_RU);
    spy.mockRestore();
  });

  it('skips the owner warning instead of failing the message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = freshState({ noKindColumn: true, claim: [], userHour: 0, notes: 0 });
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(state), msg(), makeDeps(sent));

    expect(out).toBe('busy');
    expect(sent).toHaveLength(1); // the person is still answered
    spy.mockRestore();
  });
});

describe('handleInboxMessage — degraded mode (ledger table missing)', () => {
  it('still forwards, metering the sender off bot_updates', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = freshState({ claimThrows: true, updatesLastHour: 2 });
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(state), msg(), makeDeps(sent));

    expect(out).toBe('forwarded');
    expect(sent[0]!.text).toContain('Уберите мой номер');
    expect(state.queries.some((e) => e.q.includes('from bot_updates'))).toBe(true);
    spy.mockRestore();
  });

  it('blocks (silently) a sender already over the hourly ceiling in the fallback ledger', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = freshState({ claimThrows: true, updatesLastHour: 99 });
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(state), msg(), makeDeps(sent));

    expect(out).toBe('throttled');
    expect(sent).toHaveLength(0);
    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round 2 (review): guide once a day, « · msg M», display-name junk
// ─────────────────────────────────────────────────────────────────────────────

describe('the guide is shown only on the FIRST contact of the day (Хейтер)', () => {
  it('second message in 24h: the SHORT ack — no guide, no button even with APP_URL', async () => {
    process.env.APP_URL = 'https://example.test/';
    const sent: SentMsg[] = [];
    const out = await handleInboxMessage(makeSql(freshState({ dayForwards: 1 })), msg(), makeDeps(sent));

    expect(out).toBe('forwarded');
    const ack = sent.at(-1)!;
    expect(ack.text).toBe(INBOX_COPY.ru.ack);
    expect(ack.argc).toBe(2);
    expect(ack.text).not.toContain('Если вы хотели');
  });

  it('second message, cut: short ack + the «cut» note, still no guide', async () => {
    const sent: SentMsg[] = [];
    await handleInboxMessage(
      makeSql(freshState({ dayForwards: 2 })),
      msg({ text: 'ы'.repeat(INBOX_TEXT_MAX + 1) }),
      makeDeps(sent),
    );
    expect(sent.at(-1)!.text).toBe(inboxAckHead('ru', true));
  });

  it('«busy» on first contact carries the guide (+ button); on a later one it does not', async () => {
    process.env.APP_URL = 'https://example.test/';
    const first: SentMsg[] = [];
    await handleInboxMessage(makeSql(freshState({ claim: [], userHour: 0 })), msg(), makeDeps(first));
    expect(first[0]!.text).toBe(withInboxGuide('ru', INBOX_COPY.ru.busy, true));
    expect(JSON.stringify(first[0]!.extra)).toContain('web_app');

    const later: SentMsg[] = [];
    await handleInboxMessage(makeSql(freshState({ claim: [], userHour: 0, dayForwards: 3 })), msg(), makeDeps(later));
    expect(later[0]!.text).toBe(INBOX_COPY.ru.busy);
    expect(later[0]!.argc).toBe(2);
  });

  it('«undelivered» on first contact carries the guide; on a later one it does not', async () => {
    const first: SentMsg[] = [];
    await handleInboxMessage(makeSql(freshState()), msg(), makeDeps(first, { admins: [] }));
    expect(first[0]!.text).toBe(UNDELIVERED_RU);

    const later: SentMsg[] = [];
    await handleInboxMessage(makeSql(freshState({ dayForwards: 1 })), msg(), makeDeps(later, { admins: [] }));
    expect(later[0]!.text).toBe(INBOX_COPY.ru.undelivered);
  });

  it('«throttled» never carries the guide, even with no forward today', async () => {
    const sent: SentMsg[] = [];
    await handleInboxMessage(makeSql(freshState({ claim: [], userHour: 5, dayForwards: 0 })), msg(), makeDeps(sent));
    expect(sent[0]!.text).toBe(INBOX_COPY.ru.throttled);
  });

  it('the first-contact read runs BEFORE the claim, over 24h of FORWARDED rows of this sender', async () => {
    const state = freshState();
    await handleInboxMessage(makeSql(state), msg(), makeDeps([]));
    const readAt = state.queries.findIndex((e) => e.q.includes('as day_forwards'));
    const claimAt = state.queries.findIndex((e) => e.q.includes('with w as'));
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeLessThan(claimAt);
    const read = state.queries[readAt]!;
    expect(read.q).toContain('forwarded');
    expect(read.q).toContain("interval '24 hours'");
    expect(read.values).toContain(555);
  });

  it('a failed read shows the guide (too often is harmless, never is not)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent: SentMsg[] = [];
    await handleInboxMessage(makeSql(freshState({ claimThrows: true })), msg(), makeDeps(sent));
    expect(sent.at(-1)!.text).toBe(ACK_RU);
    spy.mockRestore();
  });
});

describe('admin DM « · msg M» — so the answer can reply to the person\'s message', () => {
  it('the person\'s message_id goes into the «От:» line and is forwarded', async () => {
    const sent: SentMsg[] = [];
    await handleInboxMessage(makeSql(freshState()), msg({ messageId: 77 }), makeDeps(sent));
    expect(sent[0]!.text).toContain('От: Иван @ivanp · id 555 · msg 77\n');
  });

  it('no / invalid message_id → the old form, no « · msg»', () => {
    expect(adminInboxText({ id: 5 }, 'x', false)).toContain('От: без имени · id 5\n');
    expect(adminInboxText({ id: 5 }, 'x', false, 0)).not.toContain('· msg');
    expect(adminInboxText({ id: 5 }, 'x', false, 1.5)).not.toContain('· msg');
  });

  it('inboxDmTarget reads BOTH forms (old DMs keep working, just not attached)', () => {
    expect(inboxDmTarget(adminInboxText({ id: 555, firstName: 'Ann' }, 'x', false, 77))).toEqual({
      userId: 555,
      messageId: 77,
    });
    expect(inboxDmTarget(adminInboxText({ id: 555, firstName: 'Ann' }, 'x', false))).toEqual({
      userId: 555,
      messageId: null,
    });
  });

  it('a display name «x · id 123 · msg 9» cannot redirect the person OR the message (both forms)', () => {
    const forged = { id: 555, firstName: 'x · id 123 · msg 9' };
    expect(inboxDmTarget(adminInboxText(forged, 'hi', false, 77))).toEqual({ userId: 555, messageId: 77 });
    expect(inboxDmTarget(adminInboxText(forged, 'hi', false))).toEqual({ userId: 555, messageId: null });
    const tail = { id: 555, firstName: 'z · id 9 · msg' };
    expect(inboxDmTarget(adminInboxText(tail, 'hi', false, 77))).toEqual({ userId: 555, messageId: 77 });
  });

  it('the end anchor still holds: junk after « · msg M» is not our DM', () => {
    expect(inboxDmTarget(`${INBOX_DM_HEADER}\n\nОт: x · id 5 · msg 7 хвост`)).toBeNull();
    expect(inboxDmTarget(`${INBOX_DM_HEADER}\n\nОт: x · id 5 · msg 0`)).toEqual({ userId: 5, messageId: null });
  });
});

describe('display names: control and bidi characters are collapsed (007 m1)', () => {
  it('U+0085 (NEL — not matched by \s) cannot start a line of its own', () => {
    const dm = adminInboxText({ id: 555, firstName: 'Злой\u0085Ответить: https://evil.example\u0085От: x · id 1' }, 'hi', false);
    expect(dm).not.toContain('\u0085');
    expect(inboxDmSenderId(dm)).toBe(555);
  });

  it('U+202E (right-to-left override) and other bidi controls are removed', () => {
    const dm = adminInboxText({ id: 555, firstName: 'Ann‮555 di · ⁦x⁩‏', lastName: '؜' }, 'hi', false);
    expect(dm).not.toMatch(/[‪-‮⁦-⁩‎‏؜]/);
    expect(inboxDmSenderId(dm)).toBe(555);
  });

  it('line/paragraph separators (U+2028/U+2029) collapse too', () => {
    const dm = adminInboxText({ id: 555, firstName: 'a b c' }, 'hi', false);
    expect(dm).toContain('От: a b c · id 555');
  });
});
