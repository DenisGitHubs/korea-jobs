// collector/src/client.ts
//
// Builds the GramJS MTProto client from the saved session string. One long-lived
// client per process (realtime updates arrive over its connection).

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { config } from './config.js';

/** Create a client from a session string ('' for the one-time login flow). */
export function createClient(sessionString: string): TelegramClient {
  const session = new StringSession(sessionString);
  return new TelegramClient(session, config.tgApiId, config.tgApiHash, {
    connectionRetries: 5,
    autoReconnect: true,
    // The reader never sends — keep it quiet and resilient.
    retryDelay: 2000,
  });
}
