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
  /** Base API URL of the backend, e.g. https://<host>/api. Collector uses /ingest and /sources. */
  get ingestBaseUrl(): string {
    return req('INGEST_URL').replace(/\/+$/, '');
  },
  /** Shared bearer secret; must match the backend's INGEST_SECRET. */
  get ingestSecret(): string {
    return req('INGEST_SECRET');
  },
  get logLevel(): string {
    return process.env.LOG_LEVEL ?? 'info';
  },
};
