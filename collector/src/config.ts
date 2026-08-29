// collector/src/config.ts
//
// Environment for the reader worker. Values come from a local .env (obkatka) or the
// host's secret store. This host holds ONLY the TG session + ingest secret — never
// the Supabase service-role key or the bot token (007: secret isolation by host).
//
// Getters throw on access when a required var is missing, so `npm run login` (which
// touches only TG_API_ID/HASH) works before TG_SESSION exists, while the reader
// (`npm start`, which touches everything) fails fast on misconfig.

import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`config: ${name} is not set`);
  }
  return v;
}

/**
 * A numeric tunable, clamped into a sane range. An absent / empty / non-numeric value falls back
 * to the default rather than throwing: these knobs are operational, and a typo in the host's .env
 * must not keep the reader from starting (it would stop collection entirely). A value outside the
 * range is clamped, never obeyed — the ceilings exist for the backend's sake.
 */
function clampNum(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number((raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export const config = {
  /** Telegram MTProto app id (my.telegram.org). */
  get tgApiId(): number {
    const n = Number(req('TG_API_ID'));
    if (!Number.isInteger(n) || n <= 0) throw new Error('config: TG_API_ID must be a positive integer');
    return n;
  },
  /** Telegram MTProto app hash. */
  get tgApiHash(): string {
    return req('TG_API_HASH');
  },
  /** Reader account session string (produced by `npm run login`). Empty until then. */
  get tgSession(): string {
    return process.env.TG_SESSION ?? '';
  },
  /**
   * Origin of the deployed backend, e.g. https://<host>. INGEST_URL is normalized to
   * the bare origin: trailing slashes and a legacy trailing `/api` segment are stripped
   * (older configs used `.../api`). The ingest client appends the constant paths
   * `/api/ingest` and `/api/sources`, so both `https://host` and `https://host/api`
   * resolve to the same, correct endpoints — a URL without `/api` can no longer slip
   * past the SPA fallback and be mistaken for success.
   */
  get apiBase(): string {
    return req('INGEST_URL')
      .trim()
      .replace(/\/+$/, '') // drop trailing slash(es)
      .replace(/\/api$/i, '') // drop a trailing /api segment if present
      .replace(/\/+$/, ''); // drop any slash left before the removed /api
  },
  /** Shared bearer secret; must match the backend's INGEST_SECRET. */
  get ingestSecret(): string {
    return req('INGEST_SECRET');
  },
  get logLevel(): string {
    return process.env.LOG_LEVEL ?? 'info';
  },

  // ── Collection window (WHY: batcher.ts and schedule.ts headers) ───────────────────────────
  // The reader no longer touches the backend per message: it buffers and hands everything over
  // once per window. The window is what lets the database sleep, so these knobs decide the
  // monthly compute bill — they are not a micro-optimisation.

  /** Minutes between batch hand-overs AND source refreshes (they deliberately share one window).
   *  Clamped to 1..60. Keep it equal to the backend cron schedule so both land in one wake-up. */
  get batchIntervalMs(): number {
    return clampNum(process.env.INGEST_BATCH_MINUTES, 15, 1, 60) * 60_000;
  },
  /** Messages per outgoing REQUEST. Clamped to 1..200, because 200 is the backend per-request
   *  ceiling (lib/korea/ingest/handler.ts MAX_BATCH_ITEMS) and more comes back 413. */
  get batchChunkSize(): number {
    return clampNum(process.env.INGEST_BATCH_MAX, 200, 1, 200);
  },
  /** Buffer level at which the reader stops waiting for the window and hands over immediately.
   *  A MEMORY valve, not a latency knob: an early flush is an unplanned database wake-up worth
   *  five minutes of compute, so it sits far above the measured inflow (20-40 per quarter hour)
   *  and only fires when the buffer is genuinely filling up. Clamped to 1..INGEST_BUFFER_MAX. */
  get batchFlushAt(): number {
    const buffer = this.bufferMaxSize;
    return Math.min(buffer, clampNum(process.env.INGEST_FLUSH_AT, 800, 1, 50_000));
  },
  /** Hard ceiling on the in-memory buffer. Past it the OLDEST messages are dropped and logged —
   *  the alternative (unbounded growth) kills the reader and loses everything it holds. */
  get bufferMaxSize(): number {
    return clampNum(process.env.INGEST_BUFFER_MAX, 1_000, 50, 50_000);
  },
};
