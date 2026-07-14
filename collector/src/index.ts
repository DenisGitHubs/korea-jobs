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

import { config } from './config.js';
import { createClient } from './client.js';
import { fetchSources, postRaw } from './ingestClient.js';
import { log } from './log.js';
import { NewMessage } from 'telegram/events/index.js';
import type { NewMessageEvent } from 'telegram/events/index.js';

const HEARTBEAT_MS = 60_000;
const SOURCES_REFRESH_MS = 5 * 60_000;
const MIN_TEXT_LEN = 2; // cheap pre-filter; the AI cost-guard lives in the backend

/** Active source chat ids (as strings). Refreshed periodically. */
const activeChatIds = new Set<string>();

async function refreshSources(): Promise<void> {
  try {
    const sources = await fetchSources();
    activeChatIds.clear();
    for (const s of sources) {
      if (s.is_active && s.tg_chat_id) activeChatIds.add(String(s.tg_chat_id));
    }
    log.info('sources refreshed', { active: activeChatIds.size });
  } catch (err) {
    log.warn('sources refresh failed (keeping previous set)', { size: activeChatIds.size });
  }
}

async function main(): Promise<void> {
  // Fail fast on misconfig before connecting.
  void config.ingestBaseUrl;
  void config.ingestSecret;
  if (!config.tgSession) {
    throw new Error('TG_SESSION is empty — run `npm run login` first (the owner enters the code).');
  }

  const client = createClient(config.tgSession);
  await client.connect();
  log.info('connected to Telegram');

  await refreshSources();
  setInterval(() => void refreshSources(), SOURCES_REFRESH_MS);

  client.addEventHandler(async (event: NewMessageEvent) => {
    try {
      const msg = event.message;
      const text = msg?.message ?? '';
      if (!text || text.trim().length < MIN_TEXT_LEN) return;

      const chatId = event.chatId ? String(event.chatId) : msg?.chatId ? String(msg.chatId) : null;
      if (!chatId) return;
      // Accept only known active sources. The backend re-checks, but filtering here
      // avoids forwarding private chats / noise.
      if (activeChatIds.size > 0 && !activeChatIds.has(chatId)) return;

      await postRaw({
        tg_chat_id: chatId,
        tg_message_id: msg.id,
        sender_id: msg.senderId ? String(msg.senderId) : null,
        text,
        posted_at: new Date((msg.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      });
    } catch (err) {
      log.error('message handler failed');
    }
  }, new NewMessage({}));

  setInterval(() => log.info('heartbeat: reader alive', { sources: activeChatIds.size }), HEARTBEAT_MS);
  log.info('reader running (realtime NewMessage)');
}

main().catch((err) => {
  // Top-level fault: log and exit non-zero so the host restarts the worker.
  console.error('[collector] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
