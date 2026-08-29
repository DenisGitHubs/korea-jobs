// lib/korea/ingest/handler.test.ts
//
// POST /api/ingest, both body shapes.
//
// The invariant that matters most here is not a field — it is the QUERY COUNT. Ingest used to run
// 2..4 queries per message, and a Neon compute stays awake for 5 minutes after ANY query, so a
// realtime stream of messages kept the database awake around the clock: 110 of 100 CU-hours by
// Aug 19 2026 and a product nobody could open. A batch of 50 messages must therefore cost TWO
// queries (one source lookup + one multi-row insert), and the test below fails if that ever
// creeps back up.
//
// The rest pins what may not regress while doing it: the old single-message body still works and
// still answers with a BOOLEAN `inserted` (that type is how the reader recognises an old backend),
// unusable entries never cost the good ones, and a too-large batch is answered 413 (split it) and
// not 400 (throw it away).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/db.js', () => ({ getSql: vi.fn() }));

import type { ReqLike, ResLike } from '../core/http.js';
import { getSql } from '../core/db.js';
import { ingestPost, cleanMessage, cleanText, cleanHandle, cleanPostedAt, MAX_BATCH_ITEMS } from './handler.js';

type Row = Record<string, unknown>;

const SECRET = 'ingest-test-secret';

interface SourceSeed {
  id: string;
  tg_chat_id: string | null;
  username: string | null;
  is_active: boolean;
}

/**
 * A Neon double that answers BOTH call forms (tagged template and sql(text, params)) and routes by
 * the statement, so the handler's real query order is exercised rather than a script of answers.
 * `inserted` is modelled honestly: the insert returns one row per tuple unless told otherwise
 * (the ON CONFLICT DO NOTHING case).
 */
function makeDb(sources: SourceSeed[], opts: { insertReturns?: number } = {}) {
  const calls: { text: string; params: unknown[] }[] = [];
  const fn = (first: unknown, ...rest: unknown[]): Promise<Row[]> => {
    const isTag = Array.isArray(first) && 'raw' in (first as object);
    const text = isTag ? (first as unknown as string[]).join(' ? ') : String(first);
    const params = isTag ? rest : ((rest[0] as unknown[]) ?? []);
    calls.push({ text, params });

    if (/from\s+sources/i.test(text)) {
      // The handler asks for the sources this batch mentions; the double simply hands back the
      // seed (filtering is the database's job and is not what these tests are about).
      return Promise.resolve(sources as unknown as Row[]);
    }
    if (/insert\s+into\s+raw_messages/i.test(text)) {
      const tuples = Math.round(params.length / 7);
      const n = opts.insertReturns ?? tuples;
      return Promise.resolve(Array.from({ length: n }, (_, i) => ({ id: `raw-${i}` })));
    }
    return Promise.resolve([]);
  };
  return { fn, calls };
}

const only = <T extends { text: string }>(calls: T[], re: RegExp): T[] =>
  calls.filter((c) => re.test(c.text));

/** `auth: null` means NO Authorization header. It is deliberately not `undefined`: passing
 *  `undefined` for a parameter with a default silently re-applies the default, which in an auth
 *  test looks exactly like the door being open when in fact it was never knocked on. */
function makeReq(body: unknown, auth: string | null = `Bearer ${SECRET}`, method = 'POST'): ReqLike {
  return { method, headers: auth ? { authorization: auth } : {}, body, query: {} };
}

function makeRes() {
  return {
    statusCode: 0,
    body: '',
    setHeader(_n: string, _v: string) {},
    end(b: string) {
      this.body = b;
    },
  };
}
const bodyOf = (res: { body: string }) => JSON.parse(res.body || '{}') as Record<string, unknown>;

const msg = (id: number, over: Partial<Record<string, unknown>> = {}) => ({
  tg_chat_id: '-1001807370576',
  username: 'korea_work',
  tg_message_id: id,
  sender_id: '77712345',
  text: `вакансия ${id}`,
  posted_at: '2026-08-29T10:00:00.000Z',
  ...over,
});

const ACTIVE: SourceSeed = {
  id: '11111111-1111-1111-1111-111111111111',
  tg_chat_id: '-1001807370576',
  username: 'korea_work',
  is_active: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INGEST_SECRET = SECRET;
});

describe('ingest — the cost shape (this is what the outage was about)', () => {
  it('50 messages cost exactly TWO queries: one source lookup, one multi-row insert', async () => {
    const db = makeDb([ACTIVE]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    const messages = Array.from({ length: 50 }, (_, i) => msg(i + 1));
    await ingestPost(makeReq({ messages }), res as unknown as ResLike);

    expect(res.statusCode).toBe(200);
    expect(db.calls).toHaveLength(2); // NOT 50, and NOT 100
    expect(only(db.calls, /from\s+sources/i)).toHaveLength(1);
    const insert = only(db.calls, /insert\s+into\s+raw_messages/i)[0]!;
    expect(insert.params).toHaveLength(50 * 7);
    expect(insert.text).toContain('on conflict (source_id, tg_message_id) do nothing');
    expect(bodyOf(res)).toMatchObject({ ok: true, received: 50, inserted: 50, unknownSource: 0, invalid: 0 });
  });

  it('`inserted` is a NUMBER for a batch — the reader uses that type to spot an old backend', async () => {
    const db = makeDb([ACTIVE], { insertReturns: 1 }); // 1 new, 1 already there
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    await ingestPost(makeReq({ messages: [msg(1), msg(2)] }), res as unknown as ResLike);

    const body = bodyOf(res);
    expect(typeof body.inserted).toBe('number');
    expect(body).toMatchObject({ ok: true, received: 2, inserted: 1 });
  });

  it('an empty batch touches the database at all not once', async () => {
    const db = makeDb([ACTIVE]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    await ingestPost(makeReq({ messages: [] }), res as unknown as ResLike);

    expect(db.calls).toHaveLength(0);
    expect(bodyOf(res)).toMatchObject({ ok: true, received: 0, inserted: 0 });
  });

  it('binds every value as a parameter and never interpolates data into the statement', async () => {
    const db = makeDb([ACTIVE]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    const nasty = "'); drop table raw_messages; --";
    await ingestPost(
      makeReq({ messages: [msg(1, { text: nasty })] }),
      res as unknown as ResLike,
    );

    const insert = only(db.calls, /insert\s+into\s+raw_messages/i)[0]!;
    expect(insert.text).not.toContain('drop table');
    expect(insert.text).toContain('($1::uuid, $2::bigint, $3::bigint, $4::bigint, $5::text, $6::text, $7::timestamptz)');
    expect(insert.params).toContain(nasty);
  });
});

describe('ingest — a batch never loses the good messages to a bad one', () => {
  it('counts unusable entries and inserts the rest', async () => {
    const db = makeDb([ACTIVE]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    const messages = [
      msg(1),
      { ...msg(2), text: undefined }, // no text
      { ...msg(3), tg_chat_id: 'not-a-number' }, // an id the ::bigint cast would choke on
      null,
      msg(4),
    ];
    await ingestPost(makeReq({ messages }), res as unknown as ResLike);

    expect(bodyOf(res)).toMatchObject({ ok: true, received: 5, inserted: 2, invalid: 3 });
    const insert = only(db.calls, /insert\s+into\s+raw_messages/i)[0]!;
    expect(insert.params).toHaveLength(2 * 7);
  });

  it('messages from a chat we do not collect are accepted-and-ignored, not an error', async () => {
    const db = makeDb([ACTIVE]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    await ingestPost(
      makeReq({ messages: [msg(1), msg(2, { tg_chat_id: '-100999', username: 'random_chat' })] }),
      res as unknown as ResLike,
    );

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({ ok: true, received: 2, inserted: 1, unknownSource: 1 });
  });

  it('a source switched off is treated the same as an unknown one', async () => {
    const db = makeDb([{ ...ACTIVE, is_active: false }]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    await ingestPost(makeReq({ messages: [msg(1)] }), res as unknown as ResLike);

    expect(bodyOf(res)).toMatchObject({ ok: true, inserted: 0, unknownSource: 1 });
    expect(only(db.calls, /insert\s+into\s+raw_messages/i)).toHaveLength(0);
  });

  it('the same message twice in one batch is written once', async () => {
    const db = makeDb([ACTIVE]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    await ingestPost(makeReq({ messages: [msg(7), msg(7), msg(8)] }), res as unknown as ResLike);

    const insert = only(db.calls, /insert\s+into\s+raw_messages/i)[0]!;
    expect(insert.params).toHaveLength(2 * 7);
  });

  it('backfills tg_chat_id ONCE for a source known only by @username', async () => {
    const db = makeDb([{ ...ACTIVE, tg_chat_id: null, username: 'Korea_Work' }]); // different case on purpose
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    await ingestPost(
      makeReq({ messages: [msg(1), msg(2), msg(3)] }),
      res as unknown as ResLike,
    );

    const updates = only(db.calls, /update\s+sources/i);
    expect(updates).toHaveLength(1); // the rest of the batch already goes the fast way
    expect(updates[0]!.params).toContain('-1001807370576');
    expect(bodyOf(res)).toMatchObject({ inserted: 3, unknownSource: 0 });
  });

  it('over the item cap answers 413 (split the batch), not 400, and asks the database nothing', async () => {
    const db = makeDb([ACTIVE]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    const messages = Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, i) => msg(i + 1));
    await ingestPost(makeReq({ messages }), res as unknown as ResLike);

    expect(res.statusCode).toBe(413);
    expect(bodyOf(res)).toMatchObject({ error: 'payload_too_large', detail: 'batch_too_large' });
    expect(db.calls).toHaveLength(0);
  });
});

describe('ingest — the single-message body a deployed reader may still be sending', () => {
  it('answers with a BOOLEAN inserted', async () => {
    const db = makeDb([ACTIVE]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    await ingestPost(makeReq(msg(42)), res as unknown as ResLike);

    const body = bodyOf(res);
    expect(body).toEqual({ ok: true, inserted: true });
    expect(typeof body.inserted).toBe('boolean');
  });

  it('a re-delivered message answers inserted:false (no duplicate row)', async () => {
    const db = makeDb([ACTIVE], { insertReturns: 0 });
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    await ingestPost(makeReq(msg(42)), res as unknown as ResLike);

    expect(bodyOf(res)).toEqual({ ok: true, inserted: false });
  });

  it('keeps the unknown_source reason', async () => {
    const db = makeDb([]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    await ingestPost(makeReq(msg(42)), res as unknown as ResLike);

    expect(bodyOf(res)).toEqual({ ok: true, inserted: false, reason: 'unknown_source' });
  });

  it('still refuses a body without the required fields', async () => {
    const db = makeDb([ACTIVE]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    await ingestPost(makeReq({ tg_chat_id: '-100', text: 'hi' }), res as unknown as ResLike);

    expect(res.statusCode).toBe(400);
    expect(db.calls).toHaveLength(0);
  });
});

describe('ingest — the door', () => {
  it('401 without the bearer secret, and not a single query', async () => {
    const db = makeDb([ACTIVE]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    await ingestPost(makeReq({ messages: [msg(1)] }, null), res as unknown as ResLike);

    expect(res.statusCode).toBe(401);
    expect(db.calls).toHaveLength(0);
  });

  it('401 with the wrong secret', async () => {
    const db = makeDb([ACTIVE]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    await ingestPost(makeReq({ messages: [msg(1)] }, 'Bearer nope'), res as unknown as ResLike);

    expect(res.statusCode).toBe(401);
    expect(db.calls).toHaveLength(0);
  });

  it('404 for a non-POST method', async () => {
    const db = makeDb([ACTIVE]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    await ingestPost(makeReq({ messages: [] }, `Bearer ${SECRET}`, 'GET'), res as unknown as ResLike);

    expect(res.statusCode).toBe(404);
  });
});

describe('cleanMessage — what is allowed to reach a bound parameter', () => {
  it('accepts a chat id as a string or a number and keeps it as digits', () => {
    expect(cleanMessage(msg(1))?.chatId).toBe('-1001807370576');
    expect(cleanMessage({ ...msg(1), tg_chat_id: -1001807370576 })?.chatId).toBe('-1001807370576');
  });

  it('rejects an id that is not an integer (it would break the whole statement)', () => {
    expect(cleanMessage({ ...msg(1), tg_chat_id: '-100abc' })).toBeNull();
    expect(cleanMessage({ ...msg(1), tg_chat_id: '' })).toBeNull();
    expect(cleanMessage({ ...msg(1), tg_message_id: 1.5 })).toBeNull();
  });

  it('turns an unparsable sender id into "unknown" instead of dropping the message', () => {
    const clean = cleanMessage({ ...msg(1), sender_id: 'not-a-number' });
    expect(clean).not.toBeNull();
    expect(clean!.senderId).toBeNull();
  });

  it('clips the text to the stored maximum (bytes are the database s problem, not ours)', () => {
    const clean = cleanMessage({ ...msg(1), text: 'я'.repeat(9_000) });
    expect(clean!.text).toHaveLength(8_000);
  });

  it('fills posted_at when the reader did not send one', () => {
    const clean = cleanMessage({ ...msg(1), posted_at: undefined });
    expect(typeof clean!.postedAt).toBe('string');
    expect(Number.isNaN(Date.parse(clean!.postedAt))).toBe(false);
  });
});

describe('every field that reaches the multi-row INSERT is checked, not just the ids', () => {
  // In a one-row INSERT a bad value costs one message. In a 200-row INSERT Postgres rejects the
  // whole statement, so one poisoned field costs 200 messages. These pin the whole class.

  it('strips a NUL byte and other control characters out of the text', () => {
    const clean = cleanMessage({ ...msg(1), text: 'работа\u0000 на \u0007заводе\u001f' });
    expect(clean!.text).toBe('работа на заводе');
    expect(clean!.text).not.toContain('\u0000');
  });

  it('keeps newlines and tabs (they are part of a real posting)', () => {
    expect(cleanText('a\nb\tc')).toBe('a\nb\tc');
    expect(cleanText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('rejects a message that is nothing but control characters', () => {
    expect(cleanMessage({ ...msg(1), text: '\u0000\u0001\u0002' })).toBeNull();
    expect(cleanMessage({ ...msg(1), text: '   ' })).toBeNull();
  });

  it('never leaves half of a surrogate pair behind — not from the input, not from the clip', () => {
    expect(cleanText('ok\uD83D')).toBe('ok'); // broken input
    expect(cleanText('\uDE00ok')).toBe('ok');
    // An emoji sitting exactly on the 8000-character boundary must not be cut in half: an
    // unpaired surrogate is not valid UTF-8 and the server refuses the whole request.
    const clipped = cleanText('a'.repeat(7_999) + '😀' + 'b'.repeat(100));
    expect(clipped).toHaveLength(7_999);
    expect(/[\uD800-\uDFFF]/.test(clipped)).toBe(false);
  });

  it('accepts a real @handle and refuses anything that is not one', () => {
    expect(cleanHandle('@anna_hr')).toBe('anna_hr');
    expect(cleanHandle('anna_hr')).toBe('anna_hr');
    expect(cleanHandle('anna hr')).toBeNull(); // a space is not a handle
    expect(cleanHandle('anna-hr')).toBeNull();
    expect(cleanHandle('a'.repeat(33))).toBeNull(); // longer than Telegram allows
    expect(cleanHandle('t.me/anna?start=x')).toBeNull(); // this string would be SHOWN as a contact
    expect(cleanHandle(42)).toBeNull();
    expect(cleanHandle(undefined)).toBeNull();
  });

  it('falls back to now for a date that is missing, unparsable, ancient or in the future', () => {
    const now = Date.parse('2026-08-29T10:00:00.000Z');
    expect(cleanPostedAt('2026-08-29T09:30:00.000Z', now)).toBe('2026-08-29T09:30:00.000Z');
    expect(cleanPostedAt('yesterday-ish', now)).toBe('2026-08-29T10:00:00.000Z');
    expect(cleanPostedAt('1999-01-01T00:00:00Z', now)).toBe('2026-08-29T10:00:00.000Z');
    // A clock-skewed reader must not be able to pin a card to the top of the feed for ever.
    expect(cleanPostedAt('2027-01-01T00:00:00Z', now)).toBe('2026-08-29T10:00:00.000Z');
    expect(cleanPostedAt(undefined, now)).toBe('2026-08-29T10:00:00.000Z');
    // A few minutes of skew is normal and is kept as sent.
    expect(cleanPostedAt('2026-08-29T10:05:00.000Z', now)).toBe('2026-08-29T10:05:00.000Z');
  });

  it('a poisoned field costs ONE message, not the batch', async () => {
    const db = makeDb([ACTIVE]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    const messages = [
      msg(1),
      { ...msg(2), text: '\u0000' }, // nothing but a NUL: no message here at all
      { ...msg(3), text: 'ва\u0000кансия', posted_at: 'not-a-date', sender_username: 'bad handle!' },
      msg(4),
    ];
    await ingestPost(makeReq({ messages }), res as unknown as ResLike);

    expect(bodyOf(res)).toMatchObject({ ok: true, received: 4, inserted: 3, invalid: 1 });
    const insert = only(db.calls, /insert\s+into\s+raw_messages/i)[0]!;
    expect(insert.params).toHaveLength(3 * 7);
    expect(insert.params.some((p) => typeof p === 'string' && p.includes('\u0000'))).toBe(false);
    expect(insert.params).toContain('вакансия');
  });
});

describe('sender_username — the fallback contact of a card', () => {
  it('reaches the INSERT when the reader sends one', async () => {
    const db = makeDb([ACTIVE]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    await ingestPost(
      makeReq({ messages: [msg(1, { sender_username: 'anna_hr' })] }),
      res as unknown as ResLike,
    );

    const insert = only(db.calls, /insert\s+into\s+raw_messages/i)[0]!;
    expect(insert.params[4]).toBe('anna_hr'); // 5th column: sender_username
  });

  it('is NULL, not junk, when there is no usable handle', async () => {
    const db = makeDb([ACTIVE]);
    vi.mocked(getSql).mockReturnValue(db.fn as never);
    const res = makeRes();

    await ingestPost(
      makeReq({ messages: [msg(1), msg(2, { sender_username: 'not a handle' })] }),
      res as unknown as ResLike,
    );

    const insert = only(db.calls, /insert\s+into\s+raw_messages/i)[0]!;
    expect(insert.params[4]).toBeNull();
    expect(insert.params[11]).toBeNull();
  });
});
