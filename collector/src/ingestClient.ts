// collector/src/ingestClient.ts
//
// The collector's ONLY channel to the database: it POSTs raw messages to the
// backend ingest endpoint (which holds the service-role key and does an INSERT-only
// into raw_messages). The collector itself has no DB credentials (007).
//
// Contract with the backend (lib/korea/ingest):
//   GET  {INGEST_URL}/sources   Authorization: Bearer <INGEST_SECRET>
//        -> { sources: [{ tg_chat_id: string|null, username: string|null, is_active: boolean }] }
//   POST {INGEST_URL}/ingest    Authorization: Bearer <INGEST_SECRET>
//        body RawMessagePayload -> { ok: true, inserted: boolean }
//   The backend resolves source_id from tg_chat_id and does INSERT ... ON CONFLICT
//   (source_id, tg_message_id) DO NOTHING, so re-delivery is a harmless no-op.

import { config } from './config.js';
import { log } from './log.js';

export interface SourceRow {
  tg_chat_id: string | null;
  username: string | null;
  is_active: boolean;
}

export interface RawMessagePayload {
  tg_chat_id: string;
  username?: string | null;
  tg_message_id: number;
  sender_id?: string | null;
  sender_username?: string | null;
  text: string;
  posted_at: string; // ISO 8601
}

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${config.ingestSecret}`,
    'content-type': 'application/json',
  };
}

/** Fetch the active source list the reader should sit in. */
export async function fetchSources(): Promise<SourceRow[]> {
  const res = await fetch(`${config.ingestBaseUrl}/sources`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`fetchSources: HTTP ${res.status}`);
  const json = (await res.json()) as { sources?: SourceRow[] };
  return json.sources ?? [];
}

/**
 * POST one raw message with bounded retries + backoff. Returns true when the backend
 * accepted it (inserted or duplicate). Never throws to the caller — a persistent
 * failure is logged and dropped so one bad message can't stall the reader.
 */
export async function postRaw(payload: RawMessagePayload, retries = 3): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${config.ingestBaseUrl}/ingest`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      if (res.ok) return true;
      // 4xx (except 429) won't get better on retry — drop.
      if (res.status !== 429 && res.status < 500) {
        log.warn('ingest rejected', { status: res.status, chat: payload.tg_chat_id });
        return false;
      }
    } catch (err) {
      log.debug('ingest attempt failed', { attempt });
    }
    // backoff: 0.5s, 1s, 2s...
    await sleep(500 * 2 ** attempt);
  }
  log.warn('ingest gave up', { chat: payload.tg_chat_id, msg: payload.tg_message_id });
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
