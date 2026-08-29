// collector/src/index.ts
//
// The reader worker. Connects the saved session, learns which chats are active
// sources (from the backend, not the DB), listens for NEW messages in those chats
// in realtime, and forwards each to the ingest endpoint. Read-only: it never sends,
// replies, or joins here (joining is a separate owner-gated step — see README).
//
// Resilience: GramJS auto-reconnects; a heartbeat proves liveness (a silent death
// would stop collection with no signal); the active-source set is refreshed
// periodically so newly-approved chats are picked up without a restart. Idempotency
// is guaranteed downstream by UNIQUE(source_id, tg_message_id).
//
// ── DATABASE SLEEP (owner incident 2026-08-19; see batcher.ts + schedule.ts) ─────────────────
// "Forwards each to the ingest endpoint" above used to mean one HTTP request — and therefore one
// query, and therefore a 5-minute awake window — PER MESSAGE. Two things now keep the database
// asleep, and BOTH must stay true:
//   1. messages are BUFFERED and handed over in one batch per window (batcher.ts);
//   2. everything that reaches the backend happens in the SAME wall-clock window — the batch
//      hand-over and the source refresh ride one aligned timer (schedule.ts). Adding another
//      independent timer that touches the backend would silently undo the whole fix.
// The dialog re-prime (getDialogs) talks to Telegram only, costs the database nothing, and
// therefore keeps its own frequent schedule: the update stream must stay primed regardless.
//
// IMPORTANT (why getDialogs is mandatory): a bare connect() + addEventHandler does
// NOT start the update stream — GramJS only begins delivering NewMessage events after
// a getDialogs() call primes the update/entity state. Without it the reader connects
// but receives zero messages. We therefore call getDialogs() on every refresh: it
// both keeps the pipeline primed and maps our source @usernames to the marked chat
// ids that incoming events actually carry (event.getChat() returns a "min" entity
// with no username, so username can never be the matching key).

import { config } from './config.js';
import { createClient } from './client.js';
import { fetchSources, postRawBatch, type RawMessagePayload, type SourceRow } from './ingestClient.js';
import { log } from './log.js';
import { Batcher } from './batcher.js';
import { startAlignedInterval } from './schedule.js';
import { entityUsername, senderHandle } from './handles.js';
import { NewMessage } from 'telegram/events/index.js';
import type { NewMessageEvent } from 'telegram/events/index.js';
import type { TelegramClient } from 'telegram';

const HEARTBEAT_MS = 60_000;
/** How often the update stream is re-primed and dialog ids re-resolved. TELEGRAM ONLY — this
 *  call never reaches our backend, so its frequency does not affect database sleep. The active
 *  source LIST is fetched on the aligned window instead (see main). */
const DIALOG_PRIME_MS = 5 * 60_000;
const MIN_TEXT_LEN = 2; // cheap pre-filter; the AI cost-guard lives in the backend

/** Watchdog threshold. If NO incoming update arrives for this long while sources are
 *  loaded, the update stream has very likely stalled silently (heartbeat still ticking,
 *  connection alive, but zero events) and we recover it IN-PROCESS. 12 min tolerates a
 *  brief night-time lull across the Korean chats — an extra re-prime is harmless, so we
 *  err toward recovering. Tune here. */
const STALL_MS = 12 * 60_000;

/** Active source chat ids (as strings), in Telegram's MARKED form (e.g. "-1001807370576")
 *  — the exact form String(event.chatId) yields, so a direct `.has()` matches. Built from
 *  the account's own dialogs (username -> marked id) plus any backend rows that already
 *  carry a tg_chat_id. Refreshed periodically. */
const activeChatIds = new Set<string>();
/** Active source usernames (lower-case, no leading @). Kept only as a SECONDARY hint:
 *  incoming events expose a min chat entity without a username, so matching is by id.
 *  This still lets a rare full-entity event with a username match. */
const activeUsernames = new Set<string>();
/** Marked chat id -> its public @username (original case), resolved from the account's
 *  dialogs. Used to fill `username` in the forwarded payload (backend backfill) without
 *  a per-message network lookup, since event entities are min and carry no username. */
const activeChatUsernames = new Map<string, string>();
/** Flips true only after the first SUCCESSFUL sources load. Until then we forward
 *  nothing, so a cold reader can never leak messages from unrelated chats. */
let sourcesLoaded = false;
/** The last source list the BACKEND gave us. Kept so the frequent dialog re-prime can re-resolve
 *  usernames -> chat ids without asking the backend again: that request is a database wake-up and
 *  belongs to the aligned window only. Null until the first successful fetch. */
let lastSources: SourceRow[] | null = null;

/** Normalize a Telegram username for comparison: strip a leading @ and lower-case.
 *  Returns null for empty/absent input. */
function normUsername(u: string | null | undefined): string | null {
  if (!u) return null;
  const s = u.trim().replace(/^@/, '').toLowerCase();
  return s.length > 0 ? s : null;
}

/**
 * Re-prime the update stream and rebuild the active-chat sets.
 *
 * `fetchBackend` decides whether the backend is asked for the source LIST:
 *   * true  — the aligned window (and startup / stall recovery): one GET /api/sources, which is a
 *             database wake-up and must therefore share the window with the batch hand-over;
 *   * false — the frequent re-prime: getDialogs only, re-resolving against the LAST list we were
 *             given. Telegram-only, free as far as the database is concerned.
 */
async function refreshSources(client: TelegramClient, fetchBackend: boolean): Promise<void> {
  // 1) Prime the update pipeline AND read which chats the account is in. Done first so a
  //    slow/broken backend can never leave the reader un-primed (and thus deaf). getDialogs
  //    can be a little heavy — fine at start + once per DIALOG_PRIME_MS.
  let dialogs;
  try {
    dialogs = await client.getDialogs({});
  } catch {
    log.warn('getDialogs failed (updates may stall; keeping previous set)', {
      chatIds: activeChatIds.size,
    });
    return; // keep the previous good set; do not flip sourcesLoaded on a cold start
  }

  // 2) The backend is the source of truth for WHICH chats are active.
  if (fetchBackend) {
    try {
      lastSources = await fetchSources();
    } catch {
      log.warn('sources fetch failed (keeping previous set)', {
        chatIds: activeChatIds.size,
        usernames: activeUsernames.size,
      });
      return;
    }
  }
  const sources = lastSources;
  // No successful fetch yet (a cold reader whose first window has not come round): the stream is
  // primed, but we still forward nothing — sourcesLoaded stays false.
  if (!sources) return;

  const wantedUsernames = new Set<string>();
  const nextChatIds = new Set<string>();
  for (const s of sources) {
    if (!s.is_active) continue;
    if (s.tg_chat_id) nextChatIds.add(String(s.tg_chat_id)); // future: already-backfilled ids
    const uname = normUsername(s.username);
    if (uname) wantedUsernames.add(uname);
  }

  // 3) Resolve wanted @usernames to the account's own dialog ids. dialog.id and
  //    event.chatId are BOTH returnBigInt(utils.getPeerId(entity)) — identical marked
  //    form — so String(dialog.id) is exactly what String(event.chatId) will be. This
  //    is what makes id-matching in the handler work.
  const nextChatUsernames = new Map<string, string>();
  for (const d of dialogs) {
    const rawUname = entityUsername(d.entity);
    const key = normUsername(rawUname);
    if (key && wantedUsernames.has(key) && d.id) {
      const id = String(d.id); // marked form, matches String(event.chatId)
      nextChatIds.add(id);
      if (rawUname) nextChatUsernames.set(id, rawUname);
    }
  }

  // 4) Atomic swap of the live sets (build new, then replace) so the handler never sees
  //    a momentarily-empty set mid-refresh.
  activeChatIds.clear();
  for (const id of nextChatIds) activeChatIds.add(id);
  activeUsernames.clear();
  for (const u of wantedUsernames) activeUsernames.add(u);
  activeChatUsernames.clear();
  for (const [id, u] of nextChatUsernames) activeChatUsernames.set(id, u);

  sourcesLoaded = true;
  log.info('sources refreshed', {
    chatIds: activeChatIds.size,
    usernames: activeUsernames.size,
    resolved: activeChatUsernames.size,
  });
}

async function main(): Promise<void> {
  // Fail fast on misconfig before connecting.
  void config.apiBase;
  void config.ingestSecret;
  if (!config.tgSession) {
    throw new Error('TG_SESSION is empty — run `npm run login` first (the owner enters the code).');
  }

  const client = createClient(config.tgSession);
  await client.connect();
  log.info('connected to Telegram');

  // --- Stall-watchdog state --------------------------------------------------
  // `lastActivityAt` is proof-of-liveness for the UPDATE STREAM specifically: it is
  // bumped on every incoming NewMessage (see handler) — the only signal that events are
  // actually still being delivered. IMPORTANT: the periodic refreshSources getDialogs is
  // deliberately NOT counted as activity — a getDialogs can keep succeeding while the
  // push stream is silently dead (exactly the bug this guards), so treating it as
  // liveness would mask the stall. Only the one-time startup prime (below) bumps it.
  let lastActivityAt = Date.now();
  let stallStrikes = 0; // consecutive stall detections; escalates the recovery step
  let recovering = false; // guard: never run two recoveries at once

  // Recover a stalled update stream IN-PROCESS (no crash) so it works both under the
  // batch runner and in the background. Staged: strike 1 = cheap getDialogs re-prime;
  // strike 2+ (still silent on the next check) = soft reconnect + refresh. If recovery
  // itself throws, exit(1) as a LAST resort so a supervisor/batch restarts us clean.
  async function recoverStall(idleMs: number): Promise<void> {
    stallStrikes += 1;
    const via = stallStrikes < 2 ? 'reprime' : 'reconnect';
    log.warn('stall detected', { idleMs, strike: stallStrikes, via, chatIds: activeChatIds.size });
    try {
      if (via === 'reprime') {
        await client.getDialogs({}); // re-prime the update/entity state (cheap; often enough)
      } else {
        try {
          await client.disconnect();
        } catch {
          /* already down — fine, we're about to reconnect */
        }
        await client.connect();
        // Re-prime + rebuild the id set from the CACHED source list: a reconnect does not change
        // which chats are active, and asking the backend here would wake the database outside the
        // window for a reason that is purely Telegram-side.
        await refreshSources(client, false);
      }
      lastActivityAt = Date.now(); // fresh window before the next check
      log.info('stall recovered', { via, chatIds: activeChatIds.size });
    } catch {
      log.error('stall recovery failed — exiting for supervisor restart');
      process.exit(1);
    }
  }

  // The outbox: every accepted message goes here, and the aligned window below hands it over.
  const outbox = new Batcher<RawMessagePayload>({
    send: (items) => postRawBatch(items),
    // (postRawBatch reports the items it could NOT hand over; an empty array means all landed.)
    // Identity of a Telegram message = chat + message id. Exactly the pair the backend's
    // UNIQUE(source_id, tg_message_id) uses, so the in-memory rule and the database rule agree.
    keyOf: (m) => `${m.tg_chat_id}:${m.tg_message_id}`,
    log,
    chunkSize: config.batchChunkSize,
    flushAt: config.batchFlushAt,
    maxBuffer: config.bufferMaxSize,
  });

  // First refresh primes the update stream (its getDialogs) AND builds the id set. This one DOES
  // ask the backend — a reader that just started must not sit deaf until the first window.
  // Retried a couple of times on failure: until the first list arrives the reader forwards
  // NOTHING (no "empty set == allow everything"), so waiting a whole window here would mean
  // throwing away everything posted in that window. These extra calls happen only when the
  // backend is already failing, so they cost nothing in the normal case.
  for (let attempt = 0; attempt < 3 && !sourcesLoaded; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 10_000));
    await refreshSources(client, true);
  }
  if (!sourcesLoaded) {
    log.warn('no source list yet — collecting nothing until the first window succeeds', {
      nextWindowMinutes: config.batchIntervalMs / 60_000,
    });
  }
  lastActivityAt = Date.now(); // startup prime counts as fresh; periodic refreshes do NOT (see note above)
  // Frequent, Telegram-only re-prime: no backend call, no database wake-up.
  setInterval(() => void refreshSources(client, false), DIALOG_PRIME_MS);

  // THE ONE WINDOW that touches the backend: hand over the buffer, then refresh the source list.
  // Both on the same wall-clock boundary as the backend cron (schedule.ts), so the database wakes
  // once per interval instead of once per event. Order matters: the messages first — if the
  // source refresh fails, the batch is already delivered.
  const stopWindow = startAlignedInterval(config.batchIntervalMs, async () => {
    await outbox.flush('timer');
    await refreshSources(client, true);
  });

  client.addEventHandler(async (event: NewMessageEvent) => {
    // ANY incoming update proves the stream is alive — record it FIRST, before any
    // source filtering (messages from chats we don't collect still count as liveness).
    lastActivityAt = Date.now();
    stallStrikes = 0;
    try {
      const msg = event.message;
      const text = msg?.message ?? '';
      if (!text || text.trim().length < MIN_TEXT_LEN) return;

      // Marked chat id — identical form to what we stored in activeChatIds.
      const chatId = event.chatId ? String(event.chatId) : msg?.chatId ? String(msg.chatId) : null;
      if (!chatId) return;

      // Never forward before the first successful sources load (no "empty set == allow
      // everything").
      if (!sourcesLoaded) return;

      // Match by marked chat id (the real key). event.chat is the sync, cached (usually
      // "min") entity — no network — so its username is only a secondary hint; the real
      // @username for the backfill payload comes from our dialog-resolved map.
      const eventUsernameKey = normUsername(entityUsername(event.chat));
      const known =
        activeChatIds.has(chatId) || (eventUsernameKey !== null && activeUsernames.has(eventUsernameKey));
      if (!known) return;

      const backfillUsername = activeChatUsernames.get(chatId) ?? entityUsername(event.chat);

      // Buffer, do NOT send. The hand-over happens on the aligned window above (or right away if
      // this message fills the batch). Nothing is awaited here: the update handler must stay fast.
      outbox.add({
        tg_chat_id: chatId,
        username: backfillUsername,
        tg_message_id: msg.id,
        sender_id: msg.senderId ? String(msg.senderId) : null,
        // The AUTHOR handle, and the reason a contact-less card can still show a way to reach the
        // person (backend: sender_username -> parser/run.ts contact fallback, owner rule
        // 2026-07-19). `msg.sender` is the entity GramJS already unpacked from THIS update — a
        // plain getter, no network call, no FLOOD_WAIT risk in a busy chat. Null for a channel
        // post or an anonymous admin, which the backend already handles.
        sender_username: senderHandle(msg.sender),
        text,
        posted_at: new Date((msg.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      });
    } catch (err) {
      log.error('message handler failed');
    }
  }, new NewMessage({}));

  // Heartbeat + stall-watchdog on one 60s tick: log liveness, and if the update stream
  // has been silent past STALL_MS while sources are loaded, recover it in-process.
  setInterval(() => {
    const idleMs = Date.now() - lastActivityAt;
    // The buffer counters ride along: "alive" now also has to mean "the outbox is draining".
    // A buffered count that only grows, or a non-zero dropped, is the signal that ingest is
    // refusing us — without it the reader would look perfectly healthy while losing messages.
    log.info('heartbeat: reader alive', { sources: activeChatIds.size, idleMs, ...outbox.stats() });
    if (sourcesLoaded && !recovering && idleMs > STALL_MS) {
      recovering = true;
      void recoverStall(idleMs)
        .catch(() => {
          log.error('stall recovery crashed — exiting for supervisor restart');
          process.exit(1);
        })
        .finally(() => {
          recovering = false;
        });
    }
  }, HEARTBEAT_MS);

  // A restart (docker compose restart / a redeploy) sends SIGTERM. Whatever sits in the buffer at
  // that moment exists ONLY in this process's memory, so hand it over before leaving — otherwise
  // batching would trade "the database never sleeps" for "an ordinary restart eats a window of
  // messages". Bounded: if the flush cannot finish we still exit, and the loss is logged.
  let leaving = false;
  const shutdown = (signal: string): void => {
    if (leaving) return;
    leaving = true;
    stopWindow();
    log.info('shutting down — flushing the outbox', { signal, ...outbox.stats() });
    const forced = setTimeout(() => {
      log.error('shutdown flush timed out — leaving with messages still buffered', { ...outbox.stats() });
      process.exit(0);
    }, 15_000);
    void outbox
      .flush('shutdown')
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(forced);
        log.info('shutdown flush done', { ...outbox.stats() });
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log.info('reader running (realtime NewMessage)', {
    windowMinutes: config.batchIntervalMs / 60_000,
    chunkSize: config.batchChunkSize,
    flushAt: config.batchFlushAt,
    bufferMax: config.bufferMaxSize,
  });
}

main().catch((err) => {
  // Top-level fault: log and exit non-zero so the host restarts the worker.
  console.error('[collector] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
