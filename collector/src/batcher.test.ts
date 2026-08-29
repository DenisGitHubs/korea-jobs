// collector/src/batcher.test.ts
//
// The reader outbox. What is pinned here is not "batching works" but the properties the August
// outage taught us to care about:
//   1. NOTHING GOES OUT BETWEEN WINDOWS. One message must not buy a 5-minute database wake-up.
//   2. THE EARLY FLUSH IS A MEMORY VALVE, not a per-chunk trigger. It costs an UNPLANNED wake-up,
//      so it must sit far above the chunk size and far above the normal inflow.
//   3. NOTHING IS LOST QUIETLY. What the backend did not take is kept — per ITEM, so a partly
//      delivered batch does not drag the delivered half through again — and the only case where
//      messages are dropped (a full buffer) is counted and logged loudly.
//
// This file lives in collector/ but runs under the BACKEND vitest: the module is deliberately
// dependency-free, so no collector node_modules are needed to exercise it.

import { describe, it, expect, vi } from 'vitest';
import { Batcher, type BatcherLog } from './batcher.js';

interface Msg {
  chat: string;
  id: number;
}

const m = (id: number, chat = '-100'): Msg => ({ chat, id });

function makeLog(): BatcherLog & { lines: { level: string; msg: string }[] } {
  const lines: { level: string; msg: string }[] = [];
  return {
    lines,
    info: (msg) => void lines.push({ level: 'info', msg }),
    warn: (msg) => void lines.push({ level: 'warn', msg }),
    error: (msg) => void lines.push({ level: 'error', msg }),
  };
}

/**
 * A send double that records every chunk. It answers the way the real client does: with the items
 * it could NOT hand over ([] = everything landed).
 */
function makeSend() {
  const chunks: Msg[][] = [];
  let mode: 'accept' | 'refuse' | 'partial' = 'accept';
  /** In 'partial' mode these ids come back as not accepted. */
  let keepIds: number[] = [];
  const send = vi.fn(async (items: Msg[]): Promise<Msg[]> => {
    chunks.push([...items]);
    if (mode === 'refuse') return items;
    if (mode === 'partial') return items.filter((i) => keepIds.includes(i.id));
    return [];
  });
  return {
    send,
    chunks,
    refuse: () => {
      mode = 'refuse';
    },
    accept: () => {
      mode = 'accept';
    },
    partial: (ids: number[]) => {
      mode = 'partial';
      keepIds = ids;
    },
  };
}

function makeBatcher(opts: { chunkSize?: number; flushAt?: number; maxBuffer?: number } = {}) {
  const log = makeLog();
  const s = makeSend();
  const b = new Batcher<Msg>({
    send: s.send,
    keyOf: (x) => `${x.chat}:${x.id}`,
    log,
    chunkSize: opts.chunkSize ?? 200,
    flushAt: opts.flushAt ?? 800,
    maxBuffer: opts.maxBuffer ?? 1000,
  });
  return { b, log, ...s };
}

describe('Batcher — nothing goes out between windows', () => {
  it('buffers and sends NOTHING until the window flushes', async () => {
    const { b, send } = makeBatcher();
    for (let i = 1; i <= 10; i++) b.add(m(i));

    expect(send).not.toHaveBeenCalled(); // the whole point: no per-message wake-up
    expect(b.size()).toBe(10);

    const out = await b.flush('timer');
    expect(send).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ reason: 'timer', sent: 10, chunks: 1, failed: false, buffered: 0 });
    expect(b.size()).toBe(0);
  });

  it('an empty window makes no request at all (an idle reader never wakes the database)', async () => {
    const { b, send } = makeBatcher();
    const out = await b.flush('timer');
    expect(send).not.toHaveBeenCalled();
    expect(out).toMatchObject({ sent: 0, chunks: 0, failed: false, buffered: 0 });
  });

  it('keeps chronological order inside the batch', async () => {
    const { b, chunks } = makeBatcher();
    for (let i = 1; i <= 5; i++) b.add(m(i));
    await b.flush('timer');
    expect(chunks[0]!.map((x) => x.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('stores a re-delivered message once (same chat + message id)', async () => {
    const { b, chunks } = makeBatcher();
    b.add(m(7));
    b.add(m(7));
    b.add(m(7, '-200')); // same id, DIFFERENT chat — a different message
    expect(b.size()).toBe(2);
    expect(b.stats().duplicatesTotal).toBe(1);
    await b.flush('timer');
    expect(chunks[0]).toHaveLength(2);
  });
});

describe('Batcher — the size valve is a MEMORY valve, not a per-chunk trigger', () => {
  it('does NOT flush early just because one chunk has accumulated', async () => {
    // This is the bug the two sizes were split to fix: with one number the valve tripped every
    // chunk, and each trip bought a database wake-up outside the window.
    const { b, send } = makeBatcher({ chunkSize: 20, flushAt: 100, maxBuffer: 200 });
    for (let i = 1; i <= 99; i++) b.add(m(i));

    expect(send).not.toHaveBeenCalled();
    expect(b.size()).toBe(99);
  });

  it('flushes on its own once the buffer reaches flushAt', async () => {
    const { b, send, chunks } = makeBatcher({ chunkSize: 20, flushAt: 100, maxBuffer: 200 });
    for (let i = 1; i <= 100; i++) b.add(m(i));
    await b.flush(); // await the in-flight run started by add()

    expect(send).toHaveBeenCalled();
    expect(chunks.map((c) => c.length)).toEqual([20, 20, 20, 20, 20]); // one window, five requests
    expect(b.size()).toBe(0);
  });

  it('drains a big backlog in chunks of chunkSize inside ONE flush (one awake window)', async () => {
    const { b, chunks } = makeBatcher({ chunkSize: 20, flushAt: 800, maxBuffer: 1000 });
    for (let i = 1; i <= 45; i++) b.add(m(i));
    await b.flush('timer');

    expect(chunks.map((c) => c.length)).toEqual([20, 20, 5]);
    expect(b.size()).toBe(0);
  });
});

describe('Batcher — a refused hand-over never loses messages', () => {
  it('keeps the chunk, in order, and retries it on the next window', async () => {
    const { b, refuse, accept, chunks, log } = makeBatcher({ chunkSize: 10, flushAt: 800 });
    for (let i = 1; i <= 5; i++) b.add(m(i));

    refuse();
    const bad = await b.flush('timer');
    expect(bad).toMatchObject({ failed: true, sent: 0, kept: 5, buffered: 5 });
    expect(b.stats().failedFlushes).toBe(1);
    expect(log.lines.some((l) => l.level === 'warn')).toBe(true); // never silent

    // Messages that arrive while we were down queue BEHIND the ones we still owe.
    b.add(m(6));
    accept();
    const good = await b.flush('timer');
    expect(good).toMatchObject({ failed: false, sent: 6, kept: 0, buffered: 0 });
    expect(chunks[chunks.length - 1]!.map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps ONLY what was refused when a batch lands partly (the split case)', async () => {
    // postRawBatch isolates a poisoned message by halving, and the healthy half really is
    // delivered. Keeping the whole chunk would resend those good messages every window for ever.
    const { b, partial, accept, chunks } = makeBatcher({ chunkSize: 10, flushAt: 800 });
    for (let i = 1; i <= 6; i++) b.add(m(i));

    partial([4]); // only message 4 could not be handed over
    const out = await b.flush('timer');

    expect(out).toMatchObject({ sent: 5, kept: 1, failed: true });
    expect(b.size()).toBe(1);
    expect(b.stats().sentTotal).toBe(5);

    accept();
    await b.flush('timer');
    expect(chunks[chunks.length - 1]!.map((x) => x.id)).toEqual([4]); // just the leftover
    expect(b.size()).toBe(0);
  });

  it('treats a THROWN send as "nothing landed" — the chunk survives', async () => {
    const log = makeLog();
    const send = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const b = new Batcher<Msg>({
      send: send as unknown as (items: Msg[]) => Promise<Msg[]>,
      keyOf: (x) => `${x.chat}:${x.id}`,
      log,
      chunkSize: 10,
      flushAt: 100,
      maxBuffer: 100,
    });
    b.add(m(1));
    b.add(m(2));

    const out = await b.flush('timer');
    expect(out).toMatchObject({ failed: true, sent: 0, kept: 2, buffered: 2 });
    expect(b.size()).toBe(2);
    expect(log.lines.some((l) => l.level === 'error')).toBe(true);
  });

  it('a refusal ends the attempt: the rest of the backlog is not hammered, nothing is lost', async () => {
    const { b, refuse, chunks } = makeBatcher({ chunkSize: 10, flushAt: 100, maxBuffer: 100 });
    refuse(); // ingest is down for the whole test
    for (let i = 1; i <= 30; i++) b.add(m(i));
    await b.flush('timer');

    // Every attempt carried ONE chunk and always the OLDEST one: the loop never walked on through
    // the backlog after a refusal, and never skipped ahead past the messages it owes.
    for (const c of chunks) {
      expect(c).toHaveLength(10);
      expect(c[0]!.id).toBe(1);
    }
    expect(b.size()).toBe(30); // all 30 still held
  });

  it('a message arriving mid-send is not swallowed and does not jump the queue', async () => {
    const log = makeLog();
    const seen: Msg[][] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const b = new Batcher<Msg>({
      send: async (items) => {
        seen.push([...items]);
        if (first) {
          first = false;
          await gate; // hold the first request open
        }
        return [];
      },
      keyOf: (x) => `${x.chat}:${x.id}`,
      log,
      chunkSize: 2,
      flushAt: 2,
      maxBuffer: 100,
    });

    b.add(m(1));
    b.add(m(2)); // reaches flushAt -> flush starts and blocks inside send
    const inflight = b.flush('size');
    b.add(m(3)); // arrives while the request is open
    release!();
    await inflight;
    await b.flush('timer');

    expect(seen.map((c) => c.map((x) => x.id))).toEqual([[1, 2], [3]]);
    expect(b.size()).toBe(0);
  });

  it('a second flush during an in-flight one shares the same run (no double-send)', async () => {
    const { b, send, chunks } = makeBatcher({ chunkSize: 10, flushAt: 800 });
    b.add(m(1));
    const a = b.flush('timer');
    const c = b.flush('timer');
    expect(a).toBe(c); // the same promise, not a second request
    await a;
    expect(send).toHaveBeenCalledTimes(1);
    expect(chunks).toHaveLength(1);
  });

  it('ignores items a broken sender reports that were never in the chunk', async () => {
    const log = makeLog();
    const stranger = m(999);
    const b = new Batcher<Msg>({
      send: async () => [stranger],
      keyOf: (x) => `${x.chat}:${x.id}`,
      log,
      chunkSize: 10,
      flushAt: 100,
      maxBuffer: 100,
    });
    b.add(m(1));
    const out = await b.flush('timer');

    expect(out).toMatchObject({ sent: 1, kept: 0, failed: false });
    expect(b.size()).toBe(0); // the stranger did not get into our buffer
  });
});

describe('Batcher — the ceiling is loud, not silent', () => {
  it('drops the OLDEST past maxBuffer, counts them and logs an error once per episode', async () => {
    const { b, log, refuse } = makeBatcher({ chunkSize: 5, flushAt: 10, maxBuffer: 10 });
    refuse(); // nothing can leave, so the ceiling is what decides
    for (let i = 1; i <= 13; i++) b.add(m(i)); // 3 over the ceiling
    await b.flush('timer');

    expect(b.size()).toBe(10);
    expect(b.stats().droppedTotal).toBe(3);
    const errors = log.lines.filter((l) => l.level === 'error');
    expect(errors).toHaveLength(1); // one line per episode, not one per message
    expect(errors[0]!.msg).toContain('buffer full');
  });

  it('keeps the NEWEST when it has to choose', async () => {
    const { b, refuse, chunks } = makeBatcher({ chunkSize: 4, flushAt: 4, maxBuffer: 4 });
    refuse(); // nothing can leave; the buffer is the only place messages live
    for (let i = 1; i <= 6; i++) b.add(m(i));
    await b.flush('timer'); // joins the in-flight attempt started by the 4th add
    await b.flush('timer'); // the NEXT window shows what the buffer actually kept

    expect(b.stats().droppedTotal).toBe(2);
    // The two oldest were sacrificed, not the two newest.
    expect(chunks[chunks.length - 1]!.map((x) => x.id)).toEqual([3, 4, 5, 6]);
  });

  it('refuses sizes that contradict each other', () => {
    const log = makeLog();
    const base = { send: async (): Promise<Msg[]> => [], keyOf: (x: Msg) => String(x.id), log };
    expect(() => new Batcher<Msg>({ ...base, chunkSize: 50, flushAt: 10, maxBuffer: 100 })).toThrow(
      /flushAt/,
    );
    expect(() => new Batcher<Msg>({ ...base, chunkSize: 50, flushAt: 100, maxBuffer: 60 })).toThrow(
      /maxBuffer/,
    );
    expect(() => new Batcher<Msg>({ ...base, chunkSize: 0, flushAt: 10, maxBuffer: 100 })).toThrow(
      /chunkSize/,
    );
  });
});
