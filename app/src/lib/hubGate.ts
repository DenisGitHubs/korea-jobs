/**
 * The AppHub Studio door — the DECISIONS, kept apart from the wiring.
 *
 * Three questions live here, and nothing else does:
 *   1. which screen a shell launch opens on      -> hubEntry()
 *   2. what a refused ticket exchange means      -> hubFailure()
 *   3. how the app learns its pass died mid-use  -> watchHubSession/hubSessionLost
 *
 * The file deliberately imports NOTHING: no React, no api client, no storage.
 * That is what lets the root vitest set import it and test the rules themselves
 * (`app/__tests__/hub-door.guard.test.ts`) — the app has no DOM test runner, so
 * a decision buried inside main.tsx could only ever be guarded as TEXT.
 */

/** Which screen a 'hub' launch must open on. */
export type HubEntry =
  /** A live pass is already in this tab — mount the app, nothing to trade. */
  | 'app'
  /** Ticket in hand, no pass yet — trade it (POST /auth/hub) behind the splash. */
  | 'exchange'
  /**
   * Neither: the pass is gone or expired and the ticket is long spent (it is
   * single use and the fragment was wiped at boot). NOT the landing page —
   * "open in Telegram" is a dead end inside the shell's window, and the visitor
   * did nothing wrong. The honest screen names the one thing that helps: go
   * back to AppHub Studio and open the app again.
   */
  | 'expired';

/** What a refused exchange means for the person in front of the screen. */
export type HubFailure =
  /** Our side is down (503 misconfigured, 5xx, no network): trying again can work. */
  | 'down'
  /** The ticket itself was refused (4xx): no amount of retrying will help. */
  | 'expired';

/**
 * Which screen to open on. `hasTicket` is only consulted when there is no live
 * pass: a pass in hand always wins (a reload inside the shell keeps the session).
 */
export function hubEntry(hasLivePass: boolean, hasTicket: boolean): HubEntry {
  if (hasLivePass) return 'app';
  if (hasTicket) return 'exchange';
  return 'expired';
}

/**
 * Classify a refused exchange by HTTP status — `undefined` for a throw that
 * never reached a status (network down, DNS, a body that is not our JSON).
 *
 * The split is by who has to do something next, not by how the failure felt:
 *   4xx — the server looked at the ticket and said no (expired, wrong audience,
 *         already spent). The ticket cannot become good again, so the only move
 *         left is a NEW ticket, which only the shell can mint.
 *   everything else — 503 "hub key not configured", 5xx, a dead network. The
 *         ticket may still be fine; a second attempt is a real chance, and the
 *         60-second ticket expiring in the meantime simply lands on 4xx above
 *         next time — i.e. the honest "sign-in expired" screen, not a loop.
 */
export function hubFailure(http: number | undefined): HubFailure {
  if (typeof http === 'number' && http >= 400 && http < 500) return 'expired';
  return 'down';
}

/**
 * "The pass stopped working while the app was open."
 *
 * A pass is worth a day; a tab left open outlives it. After that every request
 * answers 401, and inside the shell there is NO way back: the ticket is spent,
 * the fragment is wiped, and reloading only proves it again. Without this hook
 * the visitor gets an app where the feed is empty, every screen shows an error
 * and no button does anything — silently, forever.
 *
 * So the ONE place that talks to the network (shared/api/client.ts) reports the
 * 401 here, and the boot code (main.tsx) — the only place that knows we are in
 * 'hub' mode — is what subscribes. Outside 'hub' mode nobody subscribes and
 * this is an empty no-op: the Telegram way in keeps its own 401 handling, byte
 * for byte.
 */
let sessionWatcher: (() => void) | null = null;

/** Subscribe (boot code, 'hub' mode only). The last caller wins; null clears. */
export function watchHubSession(fn: (() => void) | null): void {
  sessionWatcher = fn;
}

/**
 * Report a 401. Fires the watcher AT MOST ONCE: a screen typically has several
 * requests in flight, and they would all come back 401 together — the visitor
 * must get one honest screen, not a stampede of re-renders.
 */
export function hubSessionLost(): void {
  const fn = sessionWatcher;
  if (!fn) return;
  sessionWatcher = null;
  fn();
}
