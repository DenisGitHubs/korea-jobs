/**
 * AppHub Studio hand-off: the launch TICKET and our own session PASS.
 *
 * Imported for its SIDE EFFECT and imported FIRST of everything (see main.tsx):
 * the shell hands the ticket in the URL fragment (`#hub=<jws>`), and that
 * fragment has to be gone from the address bar before anything else in the app
 * runs. A ticket left in the URL survives in the history entry, in a screenshot
 * and in a link the user shares.
 *
 * The ticket is kept in a module variable and NOWHERE else: not in any site
 * store, not in a log, not in React state. It is short-lived (60 s) and single
 * use — it is traded once for our own pass (POST /api/auth/hub).
 *
 * The PASS is a different animal and is deliberately kept in sessionStorage:
 * after the trade the ticket is gone, so without a stored pass a plain tab
 * reload would throw the visitor out with nothing to re-enter with.
 * sessionStorage dies with the tab. Every access is wrapped — the store can be
 * closed (private mode, embedded WebView with storage off) and must degrade,
 * never throw; the in-memory copy keeps the current page working in that case.
 */

/** Fragment parameter the shell hands the ticket in: `#hub=<jws>`. */
const TICKET_PARAM = 'hub';

/** sessionStorage key our own pass lives under. */
const PASS_KEY = 'kj/hub-pass';

/**
 * sessionStorage key marking THIS TAB as one the shell opened. The value is a
 * bare "1" — no secret, nothing worth stealing — and, like the pass, it dies
 * with the tab.
 *
 * It exists because every other trace of the shell is designed to disappear:
 * the ticket is taken out of the URL on the first line of the boot and is
 * single use, and an expired pass is deleted the moment it is read. Without
 * this mark a tab whose pass ran out looks, after a reload, exactly like a
 * stranger's browser — and the visitor, who came from the shell and did nothing
 * wrong, would be sent to the "open in Telegram" landing page, which inside the
 * shell's own window is a dead end. With it, the launch stays a HUB launch for
 * as long as the tab lives, and the honest "sign-in expired" screen is what
 * shows up instead.
 */
const TAB_KEY = 'kj/hub-tab';

export interface HubPass {
  /** Opaque `1.<payload>.<signature>` string, sent as `Authorization: kjs <token>`. */
  token: string;
  /** Unix seconds. Past this point the backend refuses the pass. */
  expires_at: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Pull `hub=<ticket>` out of the fragment BY HAND, not with URLSearchParams:
 * that parser turns a '+' into a space, and the ticket has to reach the server
 * byte for byte.
 */
function ticketFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) !== TICKET_PARAM) continue;
    try {
      const value = decodeURIComponent(part.slice(eq + 1)).trim();
      return value ? value : null;
    } catch {
      return null; // malformed percent-escape — treat it as "no ticket"
    }
  }
  return null;
}

/** Remember that this tab came from the shell. Never throws (store can be off). */
function markHubTab(): void {
  try {
    sessionStorage.setItem(TAB_KEY, '1');
  } catch {
    /* store closed — the in-memory state carries this page instead */
  }
}

/**
 * Was this tab opened by the shell at some point? True for the whole life of
 * the tab, even after the pass has expired and been dropped — that is the point
 * (see TAB_KEY). A plain browser that never got a ticket never gets the mark,
 * so the public landing page is untouched.
 */
export function isHubTab(): boolean {
  if (launchTicket) return true;
  try {
    return sessionStorage.getItem(TAB_KEY) === '1';
  } catch {
    return false; // store closed — fall back to the traits we can still read
  }
}

/** Runs at import time. Never throws: a failure here must not stop the boot. */
function takeTicket(): string | null {
  try {
    const found = ticketFromHash(window.location.hash);
    if (!found) return null;
    // Mark the tab BEFORE anything can fail: even an exchange that never
    // succeeds (our service down, ticket already spent) must not turn this tab
    // into "a stranger's browser" on the next reload.
    markHubTab();
    // Wipe the fragment ONLY when it actually carried a ticket. Telegram hands
    // its own launch data in the very same fragment (`#tgWebAppData=…`) and the
    // SDK reads it later on — wiping unconditionally would break every real
    // Telegram launch.
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      /* history API blocked — nothing else we can do about the address bar */
    }
    return found;
  } catch {
    return null;
  }
}

const launchTicket: string | null = takeTicket();

/** The ticket this page was launched with, or null. Never persisted anywhere. */
export function hubTicketFromLaunch(): string | null {
  return launchTicket;
}

let pass: HubPass | null = null;
let passLoaded = false;

function parsePass(raw: string | null): HubPass | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<HubPass> | null;
    if (!v || typeof v.token !== 'string' || !v.token) return null;
    if (typeof v.expires_at !== 'number' || !Number.isFinite(v.expires_at)) return null;
    return { token: v.token, expires_at: v.expires_at };
  } catch {
    return null; // not our JSON — same as no pass at all
  }
}

/** The stored pass, valid-shaped or null. Expiry is NOT checked here. */
export function readHubPass(): HubPass | null {
  if (pass) return pass;
  if (passLoaded) return null;
  passLoaded = true;
  try {
    pass = parsePass(sessionStorage.getItem(PASS_KEY));
  } catch {
    pass = null; // store closed — treat as "no pass"
  }
  return pass;
}

/** Keep the pass for this tab. The in-memory copy works even with the store closed. */
export function writeHubPass(next: HubPass): void {
  pass = next;
  passLoaded = true;
  // A tab holding a pass IS a shell tab — mark it here too, so the mark does not
  // depend on the ticket still being in memory (it is wiped and single use).
  markHubTab();
  try {
    sessionStorage.setItem(PASS_KEY, JSON.stringify(next));
  } catch {
    /* store closed — the in-memory copy carries this page */
  }
}

export function clearHubPass(): void {
  pass = null;
  passLoaded = true;
  try {
    sessionStorage.removeItem(PASS_KEY);
  } catch {
    /* store closed — nothing to remove */
  }
}

/** The pass only while it is still good; an expired one is dropped on the spot. */
export function readLiveHubPass(): HubPass | null {
  const p = readHubPass();
  if (!p) return null;
  if (p.expires_at <= nowSec()) {
    clearHubPass();
    return null;
  }
  return p;
}
