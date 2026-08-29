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
//        body RawMessagePayload            -> { ok: true, inserted: boolean }   (one message)
//        body { messages: RawMessagePayload[] }
//                                          -> { ok: true, received, inserted, ... } (a batch)
//   The backend resolves source_id from tg_chat_id (or username, backfilling the id)
//   and does INSERT ... ON CONFLICT (source_id, tg_message_id) DO NOTHING, so
//   re-delivery is a harmless no-op.
//
// BATCH IS THE NORMAL PATH NOW (see batcher.ts for why: wake-ups, not bytes, are what the
// database bills). The single-message call stays for two reasons: it is what an older deployed
// backend understands, and it is the fallback below when a batch comes back 400/404 — the reader
// and the backend are deployed to different hosts and can be out of step for a while.
//
// The two answer shapes are told apart by the TYPE of `inserted` (boolean = one message,
// number = a batch), so an old backend answering a batch request cannot be read as success.

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

/** How long the one-by-one fallback may run before handing the rest back to the buffer. */
const FALLBACK_BUDGET_MS = 60_000;

/**
 * How many times a chunk may be halved inside ONE window when the backend keeps failing.
 * Bounded on purpose: halving is how a single poisoned message stops holding the whole queue
 * hostage, but unbounded halving turns an ordinary backend outage into a request storm against a
 * server that is already struggling. Four levels isolate a bad message down to a group of ~12 out
 * of 200 in one window, at a worst case of a few dozen requests instead of four.
 */
export const MAX_SPLIT_DEPTH = 4;

export interface BatchSendOptions {
  /** Retries per attempt level. Decays with split depth so a deep split cannot multiply cost. */
  retries?: number;
  /** Halvings still allowed for a persistent 5xx (see MAX_SPLIT_DEPTH). */
  splitsLeft?: number;
}

/**
 * POST a BATCH of raw messages. Resolves with the items the backend did NOT take responsibility
 * for — an EMPTY array means everything landed and may leave the reader buffer. Never throws.
 *
 * Failure handling, in the order it matters:
 *   * 413 "too large" is about the SIZE OF THE BODY, not about the messages: split in half and
 *     send both halves (a single message still too large is dropped, loudly — no split can rescue
 *     it, and jamming the buffer on it would cost every later message).
 *   * 400 / 404 means the deployed backend does not understand batches yet (deploy order). Fall
 *     back to one-by-one for this chunk, which is exactly the old behaviour, and say so.
 *   * 429 / 5xx are transient: bounded retries with backoff. If they persist, the chunk is HALVED
 *     (bounded by splitsLeft) so that one message the server chokes on cannot keep the other 199
 *     out of the database window after window. Halving happens only AFTER the retries are spent —
 *     doing it immediately would multiply load during an ordinary outage.
 *   * any other 4xx (401 with a wrong secret, say) keeps the chunk: a misconfiguration is fixed by
 *     the owner and the buffer then drains; dropping would destroy the messages instead.
 */
export async function postRawBatch(
  items: RawMessagePayload[],
  { retries = 3, splitsLeft = MAX_SPLIT_DEPTH }: BatchSendOptions = {},
): Promise<RawMessagePayload[]> {
  if (items.length === 0) return [];
  const url = `${config.apiBase}/api/ingest`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: FetchResponse;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ messages: items }),
      });
    } catch {
      log.debug('ingest batch attempt failed', { attempt, items: items.length });
      await sleep(500 * 2 ** attempt);
      continue;
    }

    if (res.ok) {
      // A bare res.ok is not enough: a misconfigured INGEST_URL yields a 200 with an HTML SPA
      // body. Require JSON with the BATCH envelope — `inserted` must be a NUMBER here.
      const json = await parseJsonBody(res, url);
      const body = json as { ok?: unknown; inserted?: unknown } | null;
      if (body && body.ok === true && typeof body.inserted === 'number') return [];
      log.error('ingest returned 200 but not the expected batch envelope — check INGEST_URL', {
        url,
        items: items.length,
      });
      return items; // a configuration error; a retry cannot fix it, so keep the chunk
    }

    if (res.status === 413) {
      if (items.length === 1) {
        const only = items[0];
        log.error('one message is too large for ingest even alone — dropping it', {
          chat: only?.tg_chat_id,
          msg: only?.tg_message_id,
        });
        return []; // "handled": it can never be delivered, and it must not jam the buffer
      }
      log.warn('ingest said the body is too large — splitting the batch in half', {
        items: items.length,
      });
      // A size split does not spend the outage budget: each half is strictly smaller, so this
      // recursion ends by itself at the single message above.
      return await halve(items, { retries, splitsLeft });
    }

    if (res.status === 400 || res.status === 404) {
      return await postOneByOne(items, retries);
    }

    if (res.status !== 429 && res.status < 500) {
      log.warn('ingest batch rejected — keeping it for the next window', {
        status: res.status,
        items: items.length,
      });
      return items;
    }

    await sleep(500 * 2 ** attempt); // 0.5s, 1s, 2s...
  }

  // Retries spent on 429/5xx (or on a transport that never answered). If the chunk is more than
  // one message, halve it: a message the backend chokes on must not keep its neighbours out of
  // the database for hours. Retries decay with depth so the isolation cannot become a storm.
  if (items.length > 1 && splitsLeft > 0) {
    log.warn('ingest still failing after retries — isolating by halving the chunk', {
      items: items.length,
      splitsLeft,
    });
    return await halve(items, { retries: Math.max(0, retries - 2), splitsLeft: splitsLeft - 1 });
  }

  log.warn('ingest batch gave up — keeping it for the next window', { items: items.length });
  return items;
}

/** Send both halves and report everything neither of them managed to hand over. */
async function halve(
  items: RawMessagePayload[],
  opts: BatchSendOptions,
): Promise<RawMessagePayload[]> {
  const mid = Math.ceil(items.length / 2);
  const first = await postRawBatch(items.slice(0, mid), opts);
  const second = await postRawBatch(items.slice(mid), opts);
  return [...first, ...second];
}

/**
 * Legacy bridge: hand the chunk over one message at a time, the way the reader worked before
 * batching. Used ONLY when the deployed backend refuses a batch body. Keeps the OLD durability
 * rules (each message gets its own retries; one the backend permanently refuses is dropped, as it
 * always was) — this is a deploy-window bridge, not the steady state.
 *
 * Bounded in time: whatever it cannot reach inside the budget is reported back as kept, so those
 * messages wait in the buffer instead of being lost.
 */
async function postOneByOne(
  items: RawMessagePayload[],
  retries: number,
): Promise<RawMessagePayload[]> {
  log.warn('backend did not accept a batch — falling back to one-by-one (deploy the backend)', {
    items: items.length,
  });
  const started = Date.now();
  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < items.length; i++) {
    if (Date.now() - started > FALLBACK_BUDGET_MS) {
      const left = items.slice(i);
      log.warn('one-by-one fallback out of time — the rest waits for the next window', {
        done: i,
        left: left.length,
      });
      return left;
    }
    const item = items[i];
    if (!item) continue;
    if (await postRaw(item, retries)) accepted += 1;
    else refused += 1;
  }
  if (refused > 0) log.warn('one-by-one fallback: some messages were refused', { accepted, refused });
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
