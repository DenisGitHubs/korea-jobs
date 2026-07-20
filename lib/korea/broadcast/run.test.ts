// lib/korea/broadcast/run.test.ts
//
// Coverage for the broadcast module. The pure text/parse helpers stay DB-free; the send loop and
// the runBroadcast orchestration are exercised through INJECTED deps (a fake clock/sender) + a fake
// `sql` tagged-template, so we assert the time-budget bail-out, the honest `total`, and the
// always-persist guarantee WITHOUT Postgres, the Bot API, or a real 45s wait.

import { describe, it, expect, vi } from 'vitest';

// getConfigNumber (broadcast_send_cap) would otherwise hit the config cache → getSql() → a real DB.
// Stub it to just return the caller's fallback; the fake sql controls the recipient set anyway.
vi.mock('../config.js', () => ({
  getConfigNumber: async (_key: string, fallback: number) => fallback,
}));

import {
  BROADCAST_TEXT_MAX,
  BROADCAST_SEND_CAP_DEFAULT,
  BROADCAST_TIME_BUDGET_MS,
  broadcastBody,
  previewText,
  resultText,
  parseBroadcastCallback,
  runDeliveryLoop,
  runBroadcast,
  type BroadcastDeps,
  type Recipient,
} from './run.js';

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('broadcastBody — strip the command token, keep the rest verbatim', () => {
  it('strips a plain /broadcast and trims the edges', () => {
    expect(broadcastBody('/broadcast Обновление вышло')).toBe('Обновление вышло');
  });
  it('strips the /broadcast@BotName form (whole first token)', () => {
    expect(broadcastBody('/broadcast@korea_rabota_bot привет всем')).toBe('привет всем');
  });
  it('preserves INTERNAL newlines (a multi-line broadcast stays multi-line)', () => {
    expect(broadcastBody('/broadcast Строка 1\nСтрока 2\n\nСтрока 4')).toBe(
      'Строка 1\nСтрока 2\n\nСтрока 4',
    );
  });
  it('handles a newline right after the command (no space)', () => {
    expect(broadcastBody('/broadcast\nтекст')).toBe('текст');
  });
  it('returns empty when only the command was sent', () => {
    expect(broadcastBody('/broadcast')).toBe('');
    expect(broadcastBody('/broadcast   ')).toBe('');
    expect(broadcastBody('/broadcast@korea_rabota_bot')).toBe('');
  });
});

describe('previewText — exact confirmation framing (plain text)', () => {
  it('frames the body with the recipient count', () => {
    expect(previewText('Мы обновились!', 128)).toBe(
      'Предпросмотр:\n\nМы обновились!\n\nОтправить всем (128 получателей)?',
    );
  });
  it('renders a zero-recipient broadcast without crashing', () => {
    expect(previewText('тест', 0)).toBe('Предпросмотр:\n\nтест\n\nОтправить всем (0 получателей)?');
  });
});

describe('resultText — the final delivery report', () => {
  it('reports sent / total / skipped when everyone was reached', () => {
    expect(resultText({ total: 100, sent: 97, skipped: 3, notReached: 0, stoppedReason: 'done' })).toBe(
      'Отправлено 97 из 100 (пропущено 3)',
    );
  });
  it('reports an all-zero (0 recipients) run without a warning line', () => {
    expect(resultText({ total: 0, sent: 0, skipped: 0, notReached: 0, stoppedReason: 'done' })).toBe(
      'Отправлено 0 из 0 (пропущено 0)',
    );
  });
  it('appends a plain-language gap line when the TIME BUDGET cut the run short', () => {
    expect(resultText({ total: 100, sent: 40, skipped: 5, notReached: 55, stoppedReason: 'timeout' })).toBe(
      'Отправлено 40 из 100 (пропущено 5)\n' +
        '⚠️ Не все получили: успели 45 из 100 — не успели разослать всем за один заход.',
    );
  });
  it('appends a plain-language gap line when the audience exceeded the CAP', () => {
    expect(resultText({ total: 1000, sent: 298, skipped: 2, notReached: 700, stoppedReason: 'cap' })).toBe(
      'Отправлено 298 из 1000 (пропущено 2)\n' +
        '⚠️ Не все получили: успели 300 из 1000 — за один раз уходит ограниченное число.',
    );
  });
});

describe('parseBroadcastCallback — bc:send/bc:cancel + uuid', () => {
  const uuid = '11111111-2222-3333-4444-555555555555';
  it('parses a send callback', () => {
    expect(parseBroadcastCallback(`bc:send:${uuid}`)).toEqual({ action: 'send', id: uuid });
  });
  it('parses a cancel callback', () => {
    expect(parseBroadcastCallback(`bc:cancel:${uuid}`)).toEqual({ action: 'cancel', id: uuid });
  });
  it('is case-insensitive on the action and the uuid', () => {
    expect(parseBroadcastCallback(`BC:SEND:${uuid.toUpperCase()}`)).toEqual({
      action: 'send',
      id: uuid.toUpperCase(),
    });
  });
  it('rejects anything that is not a well-formed bc callback', () => {
    expect(parseBroadcastCallback('bc:send:not-a-uuid')).toBeNull();
    expect(parseBroadcastCallback(`bc:delete:${uuid}`)).toBeNull();
    expect(parseBroadcastCallback(`ad:approve:${uuid}`)).toBeNull();
    expect(parseBroadcastCallback('')).toBeNull();
    expect(parseBroadcastCallback(`bc:send:${uuid} extra`)).toBeNull();
  });
});

describe('constants — Bot API headroom + conservative defaults', () => {
  it('BROADCAST_TEXT_MAX is 3800 and leaves room for the preview wrapper', () => {
    expect(BROADCAST_TEXT_MAX).toBe(3800);
    const wrapped = previewText('x'.repeat(BROADCAST_TEXT_MAX), 9999);
    expect(wrapped.length).toBeLessThan(4096);
  });
  it('BROADCAST_SEND_CAP_DEFAULT is the conservative 300 (007 rec., pre-worker)', () => {
    expect(BROADCAST_SEND_CAP_DEFAULT).toBe(300);
  });
  it('BROADCAST_TIME_BUDGET_MS is 45s, well under the 60s Vercel maxDuration', () => {
    expect(BROADCAST_TIME_BUDGET_MS).toBe(45_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Send loop (injected clock/sender — no Bot API, no real sleep)
// ─────────────────────────────────────────────────────────────────────────────

const recips = (n: number): Recipient[] =>
  Array.from({ length: n }, (_, i) => ({ id: `u${i + 1}`, tid: `${100 + i}` }));

/** now() that returns each value in turn (last value repeats), so a test can jump the clock. */
function steppingNow(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

function makeDeps(overrides: Partial<BroadcastDeps> = {}): BroadcastDeps {
  return {
    now: () => 0,
    sleep: async () => {},
    send: async () => ({ ok: true, result: { message_id: 1 } }),
    ...overrides,
  };
}

const noBudget = Number.MAX_SAFE_INTEGER;

describe('runDeliveryLoop — the actual per-recipient send loop', () => {
  it('counts every accepted send, no skips, no early stop', async () => {
    const blocked: string[] = [];
    const r = await runDeliveryLoop(
      recips(3),
      'привет',
      async (id) => void blocked.push(id),
      makeDeps(),
      noBudget,
    );
    expect(r).toEqual({ sent: 3, skipped: 0, stoppedByBudget: false });
    expect(blocked).toEqual([]);
  });

  it('a 403 counts as skipped AND flips is_blocked for that recipient only', async () => {
    const blocked: string[] = [];
    const send = vi
      .fn<BroadcastDeps['send']>()
      .mockResolvedValueOnce({ ok: true, result: { message_id: 1 } })
      .mockResolvedValueOnce({ ok: false, error_code: 403 })
      .mockResolvedValueOnce({ ok: true, result: { message_id: 1 } });
    const r = await runDeliveryLoop(
      recips(3),
      'x',
      async (id) => void blocked.push(id),
      makeDeps({ send }),
      noBudget,
    );
    expect(r).toEqual({ sent: 2, skipped: 1, stoppedByBudget: false });
    expect(blocked).toEqual(['u2']); // only the 403 recipient
  });

  it('a transient / non-403 error is skipped WITHOUT flipping is_blocked', async () => {
    const blocked: string[] = [];
    const send = vi.fn<BroadcastDeps['send']>().mockResolvedValue({ ok: false, error_code: 500 });
    const r = await runDeliveryLoop(
      recips(2),
      'x',
      async (id) => void blocked.push(id),
      makeDeps({ send }),
      noBudget,
    );
    expect(r).toEqual({ sent: 0, skipped: 2, stoppedByBudget: false });
    expect(blocked).toEqual([]);
  });

  it('a transport THROW is caught → skipped, and the loop keeps going', async () => {
    const send = vi
      .fn<BroadcastDeps['send']>()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ ok: true, result: { message_id: 1 } });
    const r = await runDeliveryLoop(recips(2), 'x', async () => {}, makeDeps({ send }), noBudget);
    expect(r).toEqual({ sent: 1, skipped: 1, stoppedByBudget: false });
  });

  it('a failing is_blocked write is best-effort — still skipped, loop not aborted', async () => {
    const send = vi
      .fn<BroadcastDeps['send']>()
      .mockResolvedValueOnce({ ok: false, error_code: 403 })
      .mockResolvedValueOnce({ ok: true, result: { message_id: 1 } });
    const r = await runDeliveryLoop(
      recips(2),
      'x',
      async () => {
        throw new Error('db blip');
      },
      makeDeps({ send }),
      noBudget,
    );
    expect(r).toEqual({ sent: 1, skipped: 1, stoppedByBudget: false });
  });

  it('bails on the TIME BUDGET before the next send (checked, not slept) and reports it', async () => {
    const send = vi.fn<BroadcastDeps['send']>().mockResolvedValue({ ok: true, result: { message_id: 1 } });
    // start=0, iter1=0, iter2=0, iter3=50_000 (> budget) → break before the 3rd send.
    const now = steppingNow([0, 0, 0, 50_000]);
    const r = await runDeliveryLoop(recips(5), 'x', async () => {}, makeDeps({ send, now }), 45_000);
    expect(r).toEqual({ sent: 2, skipped: 0, stoppedByBudget: true });
    expect(send).toHaveBeenCalledTimes(2); // the budget guard runs BEFORE the send
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runBroadcast orchestration (fake sql tagged-template + injected deps)
// ─────────────────────────────────────────────────────────────────────────────

type SqlArg = Parameters<typeof runBroadcast>[0];
interface FakeSqlState {
  persisted: { sent: number; skipped: number } | null;
  blocked: string[];
}

function makeFakeSql(opts: {
  total: number;
  recipients: Recipient[];
  persistThrows?: boolean;
}): { sql: SqlArg; state: FakeSqlState } {
  const state: FakeSqlState = { persisted: null, blocked: [] };
  const fn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join(' ');
    if (q.includes('count(*)')) return Promise.resolve([{ n: opts.total }]);
    if (q.includes('telegram_id::text')) return Promise.resolve(opts.recipients);
    if (q.includes('set is_blocked = true')) {
      state.blocked.push(String(values[0]));
      return Promise.resolve([]);
    }
    if (q.includes('set sent_n')) {
      if (opts.persistThrows) return Promise.reject(new Error('db down'));
      state.persisted = { sent: Number(values[0]), skipped: Number(values[1]) };
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  return { sql: fn as unknown as SqlArg, state };
}

describe('runBroadcast — total, always-persist, and the stop reason', () => {
  it('reaches everyone: total = full count, notReached 0, stoppedReason done, metrics persisted', async () => {
    const { sql, state } = makeFakeSql({ total: 3, recipients: recips(3) });
    const res = await runBroadcast(sql, 'bid', 'привет', makeDeps());
    expect(res).toEqual({ total: 3, sent: 3, skipped: 0, notReached: 0, stoppedReason: 'done' });
    expect(state.persisted).toEqual({ sent: 3, skipped: 0 });
  });

  it('audience beyond the cap: total is the FULL count (not recipients.length), reason cap', async () => {
    // countRecipients says 10 exist, but only 3 rows came back under the cap → the report must not
    // claim "3 из 3"; total stays 10 and the gap (7) is surfaced as a cap short-fall.
    const { sql, state } = makeFakeSql({ total: 10, recipients: recips(3) });
    const res = await runBroadcast(sql, 'bid', 'x', makeDeps());
    expect(res).toEqual({ total: 10, sent: 3, skipped: 0, notReached: 7, stoppedReason: 'cap' });
    expect(state.persisted).toEqual({ sent: 3, skipped: 0 });
  });

  it('runs out of time mid-loop: metrics are STILL persisted and reason is timeout', async () => {
    const now = steppingNow([0, 0, 0, 50_000]); // break before the 3rd send
    const { sql, state } = makeFakeSql({ total: 10, recipients: recips(5) });
    const res = await runBroadcast(sql, 'bid', 'x', makeDeps({ now }));
    expect(res).toEqual({ total: 10, sent: 2, skipped: 0, notReached: 8, stoppedReason: 'timeout' });
    expect(state.persisted).toEqual({ sent: 2, skipped: 0 }); // written even on a budget exit
  });

  it('a failed metrics write does NOT throw and still returns the tally (so the admin sees N/M)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sql } = makeFakeSql({ total: 2, recipients: recips(2), persistThrows: true });
    const res = await runBroadcast(sql, 'bid', 'x', makeDeps());
    expect(res).toEqual({ total: 2, sent: 2, skipped: 0, notReached: 0, stoppedReason: 'done' });
    spy.mockRestore();
  });
});
