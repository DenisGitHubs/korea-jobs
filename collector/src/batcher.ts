// collector/src/batcher.ts
//
// WHY THIS EXISTS (owner incident, 2026-08-19 .. 2026-08-29): the reader used to POST every
// incoming message to /api/ingest on its own. Each POST runs a query, and a Neon compute only
// falls asleep after 5 MINUTES of complete silence — so ONE message bought 5 minutes of awake
// time no matter how many milliseconds the query itself took. With ~15 chats in realtime the
// database never slept at all: 110.26 of 100 CU-hours burned by Aug 19, the product went dark
// for everybody (people could not even pass the consent screen) and stayed dark until the
// calendar period reset.
//
// So the reader now KEEPS messages and hands them over in ONE batch per window. The point is not
// fewer bytes — it is fewer WAKE-UPS: a whole quarter-hour of collection costs a single 5-minute
// awake window instead of one per message.
//
// TWO SIZES, TWO JOBS (they were one number until 2026-08-29, and that was a bug):
//   * `chunkSize` — how many messages ride in ONE request. Bounded by what the backend accepts.
//   * `flushAt`   — how full the buffer must get before the window is no longer waited for. This
//     is a MEMORY valve, not a latency feature: every early flush is an UNPLANNED database
//     wake-up worth five minutes of compute, so it must sit far above the normal inflow
//     (measured 20-40 per quarter hour) and fire only when the buffer is genuinely filling up.
//   One number for both meant the valve tripped after a single chunk — i.e. on any busy morning —
//   and quietly bought extra wake-ups that no budget accounted for.
//
// DURABILITY (nothing may vanish quietly):
//   * a chunk is handed to `send` AFTER being removed from the buffer; whatever `send` reports as
//     NOT accepted goes BACK at the head, in order, and is retried on the next window — never
//     dropped on a fault. `send` reports per ITEM, not per chunk, so a partially delivered batch
//     (the healthy half of a split) does not drag the healthy messages through again;
//   * the buffer has a hard ceiling. Past it the OLDEST items are dropped, counted and logged —
//     an unbounded buffer would instead kill the reader process, which loses everything;
//   * duplicates (same chat + message id) are stored once. Downstream idempotency is still
//     UNIQUE(source_id, tg_message_id); this is only about not wasting the wire.
//
// This module is deliberately DEPENDENCY-FREE (no config, no logger, no fetch): everything that
// touches the outside world is injected. That is what lets it be unit-tested from the backend
// vitest run, where the collector node_modules do not exist.

/** The subset of the reader logger this module needs (see log.ts). */
export interface BatcherLog {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export interface BatcherOptions<T> {
  /**
   * Hand over a chunk. Resolves with the items the backend did NOT take responsibility for — an
   * EMPTY array means "all accepted". Reporting per item rather than one boolean is what lets a
   * partially delivered batch keep only the part that actually failed.
   * A throw is caught here and treated as "none of it landed".
   */
  send: (items: T[]) => Promise<T[]>;
  /** Stable identity of an item — two items with the same key are kept once. */
  keyOf: (item: T) => string;
  log: BatcherLog;
  /** Messages per outgoing request. */
  chunkSize: number;
  /** Buffer level at which the window is no longer waited for. A memory valve: every early flush
   *  costs an unplanned database wake-up, so keep it well above the normal inflow. */
  flushAt: number;
  /** Hard ceiling on buffered items. Past it the oldest are dropped, loudly. */
  maxBuffer: number;
}

/** Why a flush ran — carried into the log so a burst is distinguishable from the timer. */
export type FlushReason = 'timer' | 'size' | 'shutdown';

export interface FlushOutcome {
  reason: FlushReason;
  /** Items the backend accepted during this flush. */
  sent: number;
  /** Requests made (a big buffer drains in several chunks inside ONE awake window). */
  chunks: number;
  /** Items refused and put back for the next window. */
  kept: number;
  /** True when anything was refused. */
  failed: boolean;
  /** Items still buffered when the flush ended. */
  buffered: number;
}

export interface BatcherStats {
  buffered: number;
  sentTotal: number;
  droppedTotal: number;
  duplicatesTotal: number;
  failedFlushes: number;
}

export class Batcher<T> {
  private readonly items: T[] = [];
  /** Keys of items that are buffered OR in flight — an in-flight chunk must still shadow a
   *  re-delivery of the same message, so a key is released only once its item is truly gone. */
  private readonly keys = new Set<string>();
  private inflight: Promise<FlushOutcome> | null = null;
  private sentTotal = 0;
  private droppedTotal = 0;
  private duplicatesTotal = 0;
  private failedFlushes = 0;
  /** True while the buffer is overflowing; keeps the drop log to one line per episode. */
  private overflowing = false;

  constructor(private readonly o: BatcherOptions<T>) {
    if (o.chunkSize < 1) throw new Error('batcher: chunkSize must be >= 1');
    if (o.flushAt < o.chunkSize) throw new Error('batcher: flushAt must be >= chunkSize');
    if (o.maxBuffer < o.flushAt) throw new Error('batcher: maxBuffer must be >= flushAt');
  }

  /** Buffer one item. Triggers an early flush once flushAt is reached. Never throws. */
  add(item: T): void {
    const key = this.o.keyOf(item);
    if (this.keys.has(key)) {
      this.duplicatesTotal += 1;
      return;
    }
    this.items.push(item);
    this.keys.add(key);
    this.trim();
    // Fire-and-forget, but never UNHANDLED: an unhandled rejection would take the whole reader
    // process down (Node exits on one), losing the buffer this class exists to protect.
    if (this.items.length >= this.o.flushAt) void this.flush('size').catch(() => undefined);
  }

  size(): number {
    return this.items.length;
  }

  stats(): BatcherStats {
    return {
      buffered: this.items.length,
      sentTotal: this.sentTotal,
      droppedTotal: this.droppedTotal,
      duplicatesTotal: this.duplicatesTotal,
      failedFlushes: this.failedFlushes,
    };
  }

  /** Drain the buffer. Concurrent calls share the one in-flight run (which drains to empty), so a
   *  timer tick landing on top of a size-triggered flush can never double-send. */
  flush(reason: FlushReason = 'timer'): Promise<FlushOutcome> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run(reason).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async run(reason: FlushReason): Promise<FlushOutcome> {
    const out: FlushOutcome = { reason, sent: 0, chunks: 0, kept: 0, failed: false, buffered: 0 };
    while (this.items.length > 0) {
      // Take the chunk OUT before sending: an overflow drop landing mid-send must not be able to
      // remove the very items we are handing over (it would splice the wrong ones back later).
      const chunk = this.items.splice(0, this.o.chunkSize);
      let kept: T[] = [];
      try {
        const reported = await this.o.send(chunk);
        // Trust, but keep the buffer sane: only items we actually handed over may come back.
        const inChunk = new Set(chunk);
        kept = reported.filter((item) => inChunk.has(item));
      } catch (err) {
        kept = chunk; // a throw means we learned nothing — assume none of it landed
        this.o.log.error('batch send threw', {
          items: chunk.length,
          err: err instanceof Error ? err.name : typeof err,
        });
      }
      out.chunks += 1;

      // Release the keys of everything that DID land, and count it as sent.
      const keptSet = new Set(kept);
      let accepted = 0;
      for (const item of chunk) {
        if (keptSet.has(item)) continue;
        this.keys.delete(this.o.keyOf(item));
        accepted += 1;
      }
      this.sentTotal += accepted;
      out.sent += accepted;

      if (kept.length > 0) {
        // Back to the HEAD, in order: these are the oldest messages we hold. Anything buffered
        // while the request was in flight stays behind them, so time order survives.
        this.items.unshift(...kept);
        this.trim();
        this.failedFlushes += 1;
        out.kept += kept.length;
        out.failed = true;
        this.o.log.warn('part of the batch was not accepted — kept for the next window', {
          reason,
          sent: accepted,
          kept: kept.length,
          buffered: this.items.length,
        });
        break;
      }
    }
    out.buffered = this.items.length;
    if (out.sent > 0 || out.failed) {
      this.o.log.info('batch flush', {
        reason,
        sent: out.sent,
        kept: out.kept,
        chunks: out.chunks,
        buffered: out.buffered,
        failed: out.failed,
      });
    }
    if (!out.failed) this.overflowing = false;
    return out;
  }

  /** Enforce the ceiling by dropping the OLDEST items. Loud on the first drop of an episode: a
   *  silent drop here is exactly the "messages disappeared and nobody noticed" failure. */
  private trim(): void {
    if (this.items.length <= this.o.maxBuffer) return;
    const excess = this.items.length - this.o.maxBuffer;
    const dropped = this.items.splice(0, excess);
    for (const item of dropped) this.keys.delete(this.o.keyOf(item));
    this.droppedTotal += dropped.length;
    if (!this.overflowing) {
      this.overflowing = true;
      this.o.log.error('buffer full — dropping the OLDEST messages (ingest is not accepting)', {
        dropped: dropped.length,
        droppedTotal: this.droppedTotal,
        maxBuffer: this.o.maxBuffer,
      });
    }
  }
}
