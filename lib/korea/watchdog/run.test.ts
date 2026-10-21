// lib/korea/watchdog/run.test.ts
//
// The silence watchdog. Two incidents stand behind every line here: 27 days with no parsing
// (25.09 → 21.10.2026, the AI credit had run out) and 15 days in August — both found by accident,
// because nothing in the database records a model call that FAILED.
//
// Time is SUBSTITUTED, never slept: the decision ("has it been silent for 24 hours?") is made in
// JS from timestamps the database hands over, so a fake clock tests the real rule.
//
// Each guard below must redden when its own protection is reverted — the reverse moves are listed
// in the report, not here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    queries: [] as { text: string; params: unknown[] }[],
    sent: [] as { chatId: string; text: string }[],
    admins: ['777000999'] as string[],
    /** The config rows the fake DB holds (key -> stored jsonb value, already unwrapped to text). */
    config: new Map<string, string | null>(),
    /** What the probe reports, as the TEXT the driver gives us (null = never). */
    lastParseAi: null as string | null,
    lastRaw: null as string | null,
    pending: 0,
    sendThrows: false,
  };
  const fakeSql = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<unknown[]> => {
    const text = typeof strings === 'string' ? strings : strings.join(' ? ');
    state.queries.push({ text, params });
    if (text.includes('last_parse_ai')) {
      return Promise.resolve([
        { last_parse_ai: state.lastParseAi, last_raw: state.lastRaw, pending: state.pending },
      ]);
    }
    if (text.includes("value #>> '{}'")) {
      const key = String(params[0]);
      return Promise.resolve([{ v: state.config.get(key) ?? null }]);
    }
    if (text.includes('insert into config')) {
      const key = String(params[0]);
      const raw = String(params[1]); // JSON.stringify(iso | null)
      state.config.set(key, raw === 'null' ? null : (JSON.parse(raw) as string));
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('../config.js', () => ({
  getConfigNumber: async (_k: string, fb: number) => fb,
  getConfigBool: async (_k: string, fb: boolean) => fb,
  getConfigString: async (_k: string, fb: string) => fb,
}));
vi.mock('../admin/auth.js', () => ({ adminRecipients: async () => h.state.admins }));
vi.mock('../bot/telegram.js', () => ({
  sendMessage: async (chatId: string, text: string) => {
    if (h.state.sendThrows) throw new Error('telegram 429');
    h.state.sent.push({ chatId: String(chatId), text });
    return { ok: true };
  },
}));

import {
  runWatchdog,
  PARSE_ALERT_AT_KEY,
  RAW_ALERT_AT_KEY,
  PARSE_SILENT_HOURS_DEFAULT,
  RAW_SILENT_HOURS_DEFAULT,
  REALERT_HOURS_DEFAULT,
} from './run.js';

const NOW = '2026-10-21T12:00:00.000Z';
const hoursAgo = (h2: number, from: string = NOW): string =>
  new Date(Date.parse(from) - h2 * 3_600_000).toISOString();

/** The healthy baseline: the AI answered an hour ago, raw arrived 10 minutes ago, 5 in the queue. */
function healthy(): void {
  h.state.lastParseAi = hoursAgo(1);
  h.state.lastRaw = hoursAgo(1 / 6);
  h.state.pending = 5;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  h.state.queries = [];
  h.state.sent = [];
  h.state.admins = ['777000999'];
  h.state.config = new Map();
  h.state.sendThrows = false;
  healthy();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('state (1): the PARSER is silent while work is waiting', () => {
  it('🔴 alerts when the AI has not answered past the threshold and the queue is NOT empty', async () => {
    h.state.lastParseAi = hoursAgo(PARSE_SILENT_HOURS_DEFAULT + 3); // 27 hours — the real incident
    h.state.pending = 412;

    const r = await runWatchdog();

    expect(r.parseSilent).toBe(true);
    expect(r.sent).toBe(1);
    const msg = h.state.sent[0]!.text;
    expect(msg).toContain('Разбор вакансий молчит');
    expect(msg).toContain('27 ч'); // how long, in whole hours
    expect(msg).toContain('412'); // how much is waiting
    expect(msg).toContain(String(PARSE_SILENT_HOURS_DEFAULT)); // and the threshold it crossed
  });

  it('🔴 does NOT alert when there is simply nothing to parse (legitimate silence)', async () => {
    h.state.lastParseAi = hoursAgo(PARSE_SILENT_HOURS_DEFAULT + 100);
    h.state.pending = 0;

    const r = await runWatchdog();

    expect(r.parseSilent).toBe(false);
    expect(r.sent).toBe(0);
    expect(h.state.sent).toHaveLength(0);
  });

  it('does not alert one hour before the threshold', async () => {
    h.state.lastParseAi = hoursAgo(PARSE_SILENT_HOURS_DEFAULT - 1);
    h.state.pending = 50;

    expect((await runWatchdog()).parseSilent).toBe(false);
    expect(h.state.sent).toHaveLength(0);
  });

  it('counts "no successful AI call EVER" as silence too (a queue that was never touched)', async () => {
    h.state.lastParseAi = null;
    h.state.pending = 7;

    const r = await runWatchdog();

    expect(r.parseSilent).toBe(true);
    expect(h.state.sent[0]!.text).toContain('никогда');
  });

  it('reads the AI ledger, not raw_messages.processed_at (which an outage keeps moving)', async () => {
    await runWatchdog();
    const probe = h.state.queries.find((q) => q.text.includes('last_parse_ai'))!;
    // During an AI outage the parser still stamps processed_at on rows it skips as 'too_old'
    // WITHOUT calling the model — that is exactly what hid the 27-day incident.
    expect(probe.text).toContain("from ai_usage where caller = 'parser'");
    expect(probe.text).not.toContain('processed_at');
  });
});

describe('state (2): the COLLECTOR is silent — a DIFFERENT alert, pointing somewhere else', () => {
  it('🔴 alerts on its own threshold, with its own text and its own place to look', async () => {
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + 1);

    const r = await runWatchdog();

    expect(r.rawSilent).toBe(true);
    expect(r.sent).toBe(1);
    const msg = h.state.sent[0]!.text;
    expect(msg).toContain('Читалка молчит');
    expect(msg).toContain('collector'); // where to go
    expect(msg).toContain('Разбор тут не виноват'); // 🔴 the two states are never merged
    expect(msg).not.toContain('Разбор вакансий молчит');
  });

  it('both states at once produce TWO separate messages, not one "something is broken"', async () => {
    h.state.lastParseAi = hoursAgo(PARSE_SILENT_HOURS_DEFAULT + 1);
    h.state.pending = 9;
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + 1);

    const r = await runWatchdog();

    expect(r.parseSilent && r.rawSilent).toBe(true);
    expect(r.sent).toBe(2);
    expect(h.state.sent.map((s) => s.text.split('\n')[0])).toEqual([
      '⚠️ Разбор вакансий молчит.',
      '⚠️ Читалка молчит.',
    ]);
  });

  it('stays quiet while raw keeps arriving', async () => {
    const r = await runWatchdog();
    expect(r.rawSilent).toBe(false);
    expect(h.state.sent).toHaveLength(0);
  });
});

describe('🔴 no spam: 96 ticks a day must not become 96 messages', () => {
  it('the next tick 15 minutes later, in the SAME state, sends nothing', async () => {
    h.state.pending = 0; // keep state (1) out of this test: an empty queue is legitimate silence
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + 1);
    await runWatchdog();
    expect(h.state.sent).toHaveLength(1);

    // 15 minutes pass. The state is unchanged (silence only got longer).
    vi.setSystemTime(new Date(Date.parse(NOW) + 15 * 60_000));
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + 1.25);
    const r = await runWatchdog();

    expect(r.rawSilent).toBe(true); // still broken...
    expect(r.notes).toContain('raw:suppressed'); // ...and deliberately not repeated
    expect(h.state.sent).toHaveLength(1); // nothing new went out
  });

  it('repeats once the re-alert window has passed, and not before', async () => {
    h.state.pending = 0;
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + 1);
    await runWatchdog();

    // One hour short of the window: still silent.
    vi.setSystemTime(new Date(Date.parse(NOW) + (REALERT_HOURS_DEFAULT - 1) * 3_600_000));
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + REALERT_HOURS_DEFAULT - 1);
    await runWatchdog();
    expect(h.state.sent).toHaveLength(1);

    // Past the window: one reminder.
    vi.setSystemTime(new Date(Date.parse(NOW) + REALERT_HOURS_DEFAULT * 3_600_000));
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + REALERT_HOURS_DEFAULT);
    const r = await runWatchdog();

    expect(r.notes).toContain('raw:realert');
    expect(h.state.sent).toHaveLength(2);
  });

  it('remembers the standing alert in config, and reads it back from the TABLE (not a cache)', async () => {
    h.state.pending = 0;
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + 1);
    await runWatchdog();

    expect(h.state.config.get(RAW_ALERT_AT_KEY)).toBe(NOW);
    expect(h.state.config.has(PARSE_ALERT_AT_KEY)).toBe(false); // the other state is untouched
    const read = h.state.queries.filter((q) => q.text.includes("value #>> '{}'"));
    expect(read.length).toBeGreaterThanOrEqual(2); // one per state, straight from `config`
  });
});

describe('recovery: "ожил", once — and the next breakage alerts immediately', () => {
  it('sends one recovery message when the state clears, and clears the stored alert', async () => {
    h.state.pending = 0;
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + 1);
    await runWatchdog();
    h.state.sent = [];

    // Two hours later the collector is back.
    vi.setSystemTime(new Date(Date.parse(NOW) + 2 * 3_600_000));
    h.state.lastRaw = hoursAgo(0.1, new Date(Date.parse(NOW) + 2 * 3_600_000).toISOString());
    const r = await runWatchdog();

    expect(r.rawSilent).toBe(false);
    expect(r.notes).toContain('raw:recovered');
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0]!.text).toContain('Читалка ожила');
    expect(h.state.config.get(RAW_ALERT_AT_KEY)).toBeNull(); // forgotten, not kept
  });

  it('🔴 a NEW breakage after a recovery alerts at once (no leftover suppression)', async () => {
    h.state.pending = 0;
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + 1);
    await runWatchdog(); // alert

    vi.setSystemTime(new Date(Date.parse(NOW) + 2 * 3_600_000));
    h.state.lastRaw = hoursAgo(0.1, new Date(Date.parse(NOW) + 2 * 3_600_000).toISOString());
    await runWatchdog(); // recovery
    h.state.sent = [];

    // Three hours after the recovery it breaks again — well INSIDE the 24h re-alert window.
    const later = Date.parse(NOW) + 5 * 3_600_000;
    vi.setSystemTime(new Date(later));
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + 1, new Date(later).toISOString());
    const r = await runWatchdog();

    expect(r.notes).toContain('raw:alert'); // a FIRST alert again, not a suppressed repeat
    expect(h.state.sent).toHaveLength(1);
  });

  it('a recovery is not re-sent on every later tick', async () => {
    h.state.pending = 0;
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + 1);
    await runWatchdog();
    vi.setSystemTime(new Date(Date.parse(NOW) + 2 * 3_600_000));
    h.state.lastRaw = hoursAgo(0.1, new Date(Date.parse(NOW) + 2 * 3_600_000).toISOString());
    await runWatchdog();
    h.state.sent = [];

    vi.setSystemTime(new Date(Date.parse(NOW) + 2.25 * 3_600_000));
    const r = await runWatchdog();

    expect(h.state.sent).toHaveLength(0);
    expect(r.notes).toEqual([]);
  });
});

describe('it must never cost the tick anything', () => {
  it('🔴 no admin in the database → quiet exit, no throw, nothing sent', async () => {
    h.state.admins = [];
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + 1);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await runWatchdog();

    expect(r.rawSilent).toBe(true); // it still KNOWS
    expect(r.sent).toBe(0);
    expect(r.notes).toContain('no_admin');
    // One log line, with a count and a name — no id, because there is no recipient to name.
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('[watchdog] no admin recipient');
    spy.mockRestore();
  });

  it('a Telegram failure is swallowed (the watchdog is the tick\'s last, best-effort step)', async () => {
    h.state.sendThrows = true;
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + 1);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await runWatchdog();

    expect(r.rawSilent).toBe(true); // it still knows, and still remembered the standing alert
    expect(r.sent).toBe(0);
    expect(r.notes).toContain('raw:alert');
    // 🔴 The failure is handled AT THE MESSAGE, not by the whole-run safety net: if the inner
    // try/catch goes away, the throw reaches the outer catch and the note becomes 'error'.
    expect(r.notes).not.toContain('error');
    spy.mockRestore();
  });

  it('a database fault is swallowed and reported as a note, never thrown', async () => {
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + 1);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = () => Promise.reject(new Error('relation "ai_usage" does not exist'));
    const db = await import('../core/db.js');
    const orig = db.getSql;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(db, 'getSql').mockReturnValue(broken as any);

    const r = await runWatchdog();

    expect(r.notes).toContain('error');
    expect(r.sent).toBe(0);
    vi.mocked(db.getSql).mockImplementation(orig);
    spy.mockRestore();
  });
});

describe('🔴 what goes out carries numbers and names only', () => {
  it('no telegram id, no internal id, and no ad text in the message', async () => {
    h.state.lastParseAi = hoursAgo(PARSE_SILENT_HOURS_DEFAULT + 1);
    h.state.pending = 11;
    h.state.lastRaw = hoursAgo(RAW_SILENT_HOURS_DEFAULT + 1);

    await runWatchdog();

    const all = h.state.sent.map((s) => s.text).join('\n');
    expect(all).not.toContain('777000999'); // the recipient's own id is never written INTO the text
    expect(all).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no uuid of anything
    expect(all).not.toMatch(/01[0-9]-?[0-9]{3,4}-?[0-9]{4}/); // no korean phone shape
    // The only names it may mention are OUR names (a config/env variable, a component).
    expect(all).toContain('ANTHROPIC_API_KEY');
  });

  it('cannot leak an ad text, because it never reads one: the probe selects only aggregates', async () => {
    await runWatchdog();
    const probe = h.state.queries.find((q) => q.text.includes('last_parse_ai'))!;

    expect(probe.text).toContain('max(called_at)');
    expect(probe.text).toContain('max(fetched_at)');
    expect(probe.text).toContain('count(*)');
    // No message text, no contact, no sender — nothing that could be a person or their words.
    // A `::text` CAST is fine (it is the only safe way to read a timestamptz through this driver);
    // what must not appear is the raw message's TEXT COLUMN as a selected name.
    expect(probe.text).not.toMatch(/(^|[\s,(])text(\s|,|\))/);
    expect(probe.text).not.toContain('contact');
    expect(probe.text).not.toContain('sender');
    expect(probe.text).not.toContain('telegram_id');
  });

  it('reads the timestamps as TEXT (the Neon driver returns objects for timestamptz)', async () => {
    await runWatchdog();
    const probe = h.state.queries.find((q) => q.text.includes('last_parse_ai'))!;
    expect(probe.text).toContain('max(called_at)::text');
    expect(probe.text).toContain('max(fetched_at)::text');
  });
});
