// collector/src/ingestClient.ts
//
// The collector's ONLY channel to the database: it POSTs raw messages to the
// backend ingest endpoint (which holds the service-role key and does an INSERT-only
// into raw_messages). The collector itself has no DB credentials (007).
//
// Contract with the backend (lib/korea/ingest). Paths are built from config.apiBase
// (the backend origin) with the CONSTANT `/api/...` prefix, so a misconfigured
// INGEST_URL cannot silently target the SPA and get an HTML 200:
//   GET  {apiBase}/api/sources   Authorization: Bearer <INGEST_SECRET>
//        -> { sources: [{ tg_chat_id: string|null, username: string|null, is_active: boolean }] }
//   POST {apiBase}/api/ingest    Authorization: Bearer <INGEST_SECRET>
//        body RawMessagePayload -> { ok: true, inserted: boolean }
//   The backend resolves source_id from tg_chat_id (or username, backfilling the id)
//   and does INSERT ... ON CONFLICT (source_id, tg_message_id) DO NOTHING, so
//   re-delivery is a harmless no-op.

import { config } from './config.js';
import { log } from './log.js';

/** The type `fetch` resolves to, without depending on a global `Response` name. */
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/**
 * Parse a response body as JSON ONLY when the server actually returned JSON. A 200
 * whose body is HTML (an SPA fallback served because INGEST_URL doesn't point at the
 * deployed backend) must never be treated as success. Returns null (and logs a clear
 * config error) on a non-JSON / malformed body.
 */
async function parseJsonBody(res: FetchResponse, url: string): Promise<unknown | null> {
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    log.error(
      'ingest endpoint returned non-JSON — check INGEST_URL / that it points at the deployed backend',
      { url, status: res.status, contentType },
    );
    return null;
  }
  try {
    return await res.json();
  } catch {
    log.error('ingest endpoint returned malformed JSON — check INGEST_URL', { url, status: res.status });
    return null;
  }
}

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
  const url = `${config.apiBase}/api/sources`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`fetchSources: HTTP ${res.status}`);
  const json = await parseJsonBody(res, url);
  // A non-JSON 200 (HTML SPA fallback) or the wrong shape is a config error, not an
  // empty source list — throw so refreshSources keeps its previous set and never
  // flips sourcesLoaded on bad data.
  if (!json || typeof json !== 'object' || !Array.isArray((json as { sources?: unknown }).sources)) {
    throw new Error('fetchSources: response was not the expected { sources: [...] } JSON');
  }
  return (json as { sources: SourceRow[] }).sources;
}

/**
 * POST one raw message with bounded retries + backoff. Returns true when the backend
 * accepted it (inserted or duplicate). Never throws to the caller — a persistent
 * failure is logged and dropped so one bad message can't stall the reader.
 */
export async function postRaw(payload: RawMessagePayload, retries = 3): Promise<boolean> {
  const url = `${config.apiBase}/api/ingest`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        // A bare `res.ok` is not enough: a misconfigured INGEST_URL yields a 200 with
        // an HTML SPA body. Require JSON with the backend envelope { ok:true, inserted }.
        const json = await parseJsonBody(res, url);
        const body = json as { ok?: unknown; inserted?: unknown } | null;
        if (body && body.ok === true && typeof body.inserted === 'boolean') return true;
        // 200 but not our envelope = configuration error, not a transient fault.
        // Retrying can't fix it — stop and report failure (never a false success).
        log.error('ingest returned 200 but not the expected JSON envelope — check INGEST_URL', {
          url,
          chat: payload.tg_chat_id,
        });
        return false;
      }
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
