// collector/src/join.ts
//
// ONE-OFF, owner-gated helper: makes the reader account JOIN the active source
// chats, ONE every ~3 minutes (owner-set pace), so Telegram's anti-spam does not
// flag a burst of joins. Run by the owner's command only:
//   npm run join
//
// Safety:
//  - joins one chat, then waits ~3 min (+ small jitter) before the next FRESH join;
//  - skips chats the account is already in (no wait), so re-runs are cheap/idempotent;
//  - on FLOOD_WAIT it backs off exactly as long as Telegram asks, then retries;
//  - unresolvable usernames (e.g. private invite hashes) are tried as invite links,
//    then skipped with a log — never crashes the run.
//
// IMPORTANT: do NOT run this at the same time as `npm start` (the reader) — both use
// the same account session, and two live clients on one session can break it.

import { config } from './config.js';
import { createClient } from './client.js';
import { fetchSources } from './ingestClient.js';
import { log } from './log.js';
import { Api } from 'telegram';

const JOIN_INTERVAL_MS = 3 * 60_000; // owner-set: one fresh join every 3 minutes
const JITTER_MS = 25_000; // small human-like variation on top of the interval
const SKIP_PAUSE_MS = 8_000; // short pause after an already-in / skipped chat

type Result = 'joined' | 'already' | 'skipped';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function normUsername(u: string | null | undefined): string | null {
  if (!u) return null;
  const s = u.trim().replace(/^@/, '').toLowerCase();
  return s.length > 0 ? s : null;
}

/** Extract a FLOOD_WAIT delay (seconds) from a GramJS error, or null if not a flood. */
function floodSeconds(err: unknown): number | null {
  const e = err as { seconds?: number; errorMessage?: string; message?: string };
  if (typeof e?.seconds === 'number') return e.seconds;
  const m = String(e?.errorMessage ?? e?.message ?? '').match(/FLOOD(?:_WAIT)?_(\d+)/);
  return m ? Number(m[1]) : null;
}

function hasMsg(err: unknown, needle: string): boolean {
  const e = err as { errorMessage?: string; message?: string };
  return String(e?.errorMessage ?? e?.message ?? '').includes(needle);
}

// Try to join a single source. Throws ONLY on FLOOD_WAIT (so the caller can back
// off and retry); every other failure is swallowed into a 'skipped' result.
async function joinOne(client: ReturnType<typeof createClient>, raw: string): Promise<Result> {
  const username = raw.trim().replace(/^@/, '');

  let entity: unknown;
  try {
    entity = await client.getEntity(username);
  } catch (e) {
    if (floodSeconds(e) != null) throw e;
    // Not a public username — maybe a private invite hash (bare, no '+'). Try it.
    try {
      await client.invoke(new Api.messages.ImportChatInvite({ hash: username }));
      return 'joined';
    } catch (e2) {
      if (floodSeconds(e2) != null) throw e2;
      if (hasMsg(e2, 'USER_ALREADY_PARTICIPANT')) return 'already';
      log.warn('source could not be resolved — skipped', { username });
      return 'skipped';
    }
  }

  // Already a member? (cheap check — avoids a needless join action + its 3-min wait)
  try {
    await client.invoke(
      new Api.channels.GetParticipant({ channel: entity as never, participant: 'me' }),
    );
    return 'already';
  } catch (e) {
    if (floodSeconds(e) != null) throw e;
    // USER_NOT_PARTICIPANT (or not a channel type) — fall through to join.
  }

  try {
    await client.invoke(new Api.channels.JoinChannel({ channel: entity as never }));
    return 'joined';
  } catch (e) {
    if (floodSeconds(e) != null) throw e;
    if (hasMsg(e, 'USER_ALREADY_PARTICIPANT')) return 'already';
    log.warn('join failed — skipped', { username });
    return 'skipped';
  }
}

// Wrap joinOne with FLOOD_WAIT backoff+retry for this one source.
async function processSource(
  client: ReturnType<typeof createClient>,
  raw: string,
  key: string,
): Promise<Result> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await joinOne(client, raw);
    } catch (e) {
      const fw = floodSeconds(e);
      if (fw != null) {
        log.warn('FLOOD_WAIT — backing off', { username: key, seconds: fw });
        await sleep((fw + 5) * 1000);
        continue;
      }
      log.error('join error — skipped', { username: key });
      return 'skipped';
    }
  }
  return 'skipped';
}

async function main(): Promise<void> {
  if (!config.tgSession) {
    throw new Error('TG_SESSION is empty — run `npm run login` first.');
  }

  const client = createClient(config.tgSession);
  await client.connect();
  log.info('connected to Telegram (join mode)');

  const sources = await fetchSources();
  const list: Array<{ raw: string; key: string }> = [];
  const seen = new Set<string>();
  for (const s of sources) {
    if (!s.is_active) continue;
    const key = normUsername(s.username);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    list.push({ raw: (s.username ?? '').trim().replace(/^@/, ''), key });
  }
  log.info('active sources to process', { count: list.length });

  let joined = 0;
  let already = 0;
  let skipped = 0;

  for (let i = 0; i < list.length; i++) {
    const { raw, key } = list[i];
    const result = await processSource(client, raw, key);
    if (result === 'joined') joined++;
    else if (result === 'already') already++;
    else skipped++;
    log.info(`[${i + 1}/${list.length}] ${key} -> ${result}`, { joined, already, skipped });

    if (i < list.length - 1) {
      if (result === 'joined') {
        const wait = JOIN_INTERVAL_MS + Math.floor(Math.random() * JITTER_MS);
        log.info('pausing before next join', { seconds: Math.round(wait / 1000) });
        await sleep(wait);
      } else {
        await sleep(SKIP_PAUSE_MS);
      }
    }
  }

  log.info('JOIN RUN DONE', { joined, already, skipped, total: list.length });
  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('[join] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
