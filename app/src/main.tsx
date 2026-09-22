import './lib/hubTicket';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { bootstrapTelegram } from './lib/telegram';
import { detectLaunchMode } from './lib/launchEnv';
import { clearHubPass, hubTicketFromLaunch, readLiveHubPass, writeHubPass } from './lib/hubTicket';
import { hubEntry, hubFailure, watchHubSession, type HubFailure } from './lib/hubGate';
import { ApiError, api } from './shared/api/client';
import { initTheme } from './lib/theme';
import { normalizeLang, setupI18n } from './i18n';
import { loadStoredLang, loadStoredThemeMode, useSettingsStore } from './store/settingsStore';
import { useFilterStore } from './store/filterStore';
import { OutsideTelegram } from './components/OutsideTelegram';
import { HubDown } from './components/HubDown';
import { HubExpired } from './components/HubExpired';
import { Splash } from './components/Splash';
import App from './App';
import './index.css';

// './lib/hubTicket' IS THE FIRST IMPORT ON PURPOSE — do not move it.
// Import declarations are evaluated in order, so that module's side effect (take
// the AppHub Studio ticket out of the URL fragment and wipe the fragment) runs
// before any other line of ours. There is no third-party script on this page and
// the CSP (script-src 'self') would not let one in, so this is the earliest
// point our code can occupy. An inline <script> in <head> would NOT work: the
// same CSP forbids it, and weakening the CSP for this is not on the table.

// FIRST — before bootstrapTelegram() installs the browser mock, which would make
// every environment look like Telegram. Three ways in now (see lib/launchEnv.ts):
// 'telegram' (unchanged), 'hub' (AppHub Studio shell) and 'outside' (plain
// browser — no session to load, so a static page instead of the app).
const mode = detectLaunchMode();
const outside = mode === 'outside';

// Side-effect bootstrap BEFORE React mounts — but ONLY inside Telegram.
//
// It must be skipped in the other two modes, and not merely because the landing
// page has no use for it: bootstrapTelegram() installs the browser mock
// (installMock -> mockTelegramEnv), and the SDK persists those fake launch
// params under sessionStorage['tapps/launchParams']. That cache is one of the
// traits detectLaunchMode() reads. Running it here would therefore poison the
// NEXT load of the same tab: first visit -> landing (correct), reload -> the
// cache says "Telegram", the full app mounts, /me answers 401 and the error
// strip is back — exactly the state that got the ad rejected, reachable by
// pressing F5. In 'hub' mode it would additionally lie about the environment:
// there is no Telegram client next to the shell, so telegram-only buttons
// (share, support) must take the same fallback path they take in a browser —
// which is what isReal: false tells them.
const ctx =
  mode === 'telegram'
    ? bootstrapTelegram()
    : { languageCode: undefined, username: undefined, isReal: false };

// The public page is always dark (it matches the shell index.html pre-paints);
// inside Telegram — and inside the AppHub Studio shell, which is a real session
// and not a leaflet — the user's own theme mode still rules.
const themeMode = loadStoredThemeMode();
initTheme(outside ? 'dark' : themeMode);

// Outside Telegram — landing page or shell alike — there is no Telegram account
// to take a language from: follow the saved choice first, the browser second, so
// a non-Russian visitor gets the page in English.
const lang =
  loadStoredLang() ?? normalizeLang(mode === 'telegram' ? ctx.languageCode : navigator.language);
setupI18n(lang);
useSettingsStore.getState().init({ lang, isReal: ctx.isReal, username: ctx.username, themeMode });

// Restore a saved feed filter synchronously (like lang/theme above) so the feed's
// first request already carries it — no cold-start race. Nothing saved → the store
// stays uninitialized and the subscription default is seeded after /me hydrates.
useFilterStore.getState().initFromStorage();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

const root = createRoot(rootEl);

/**
 * Trade the shell's ticket for our own pass. The ticket is worth 60 seconds and
 * is single use; the pass is what every later request carries.
 *
 * The answer is an OUTCOME, not a boolean, and that is the whole point: the
 * backend already separates "this deployment has no hub key" (503) from "this
 * ticket is no good" (401), and a `catch {}` that flattened both into `false`
 * threw that truth away — every failure then showed the same "Open in Telegram"
 * page, the one screen that helps nobody inside the shell's window. Status in,
 * screen out; the mapping itself lives in lib/hubGate.ts, where it is testable.
 *
 * Nothing is stored unless the pass is real and still in date: a visitor who
 * cannot be identified must never get an app whose every screen 401s.
 */
async function exchangeHubTicket(ticket: string): Promise<'ok' | HubFailure> {
  try {
    const session = await api.authHub(ticket);
    // A 200 with a body we cannot use is our side misbehaving, not the ticket
    // going bad — same class as a 5xx, so: "down", and retrying is fair advice.
    if (!session || typeof session.token !== 'string' || !session.token) return 'down';
    if (typeof session.expires_at !== 'number' || !Number.isFinite(session.expires_at)) return 'down';
    if (session.expires_at <= Math.floor(Date.now() / 1000)) return 'down';
    writeHubPass({ token: session.token, expires_at: session.expires_at });
    return 'ok';
  } catch (e) {
    // ApiError carries the server's status; anything else (network, DNS, an
    // abort) never got one — hubFailure() reads `undefined` as "our side".
    return hubFailure(e instanceof ApiError ? e.http : undefined);
  }
}

/** Mount the app — and, in the shell, arm the one watch for a dead pass. */
function renderApp(): void {
  // The pass is good for a day; a tab can easily outlive it. When it dies, the
  // client reports the first 401 (shared/api/client.ts) and the app is replaced
  // by the honest screen — instead of a feed that never loads, errors on every
  // screen and buttons that do nothing, with no way back and no explanation.
  // Telegram launches never subscribe: their 401 handling is untouched.
  if (mode === 'hub') {
    watchHubSession(() => {
      // THROW THE DEAD PASS AWAY FIRST, then draw the screen — order matters.
      //
      // readLiveHubPass() only ever drops a pass by its OWN expires_at, and a
      // pass the server has REVOKED still carries a date in the future: nothing
      // in storage would ever remove it. Left there it keeps riding along in the
      // `Authorization: kjs` header of every later request this tab makes, and a
      // reload reads it as "a live pass" (hubEntry -> 'app'), mounts the whole
      // app again and walks straight into the next 401 — the silent broken app
      // this watch exists to prevent, one F5 away.
      //
      // Done HERE and not in lib/hubGate.ts on purpose: that module imports
      // nothing (no React, no storage), which is the only reason the door's
      // decisions can be tested at all. The wiring lives in the boot code.
      clearHubPass();
      root.render(
        <StrictMode>
          <HubExpired />
        </StrictMode>,
      );
    });
  }
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

/** Trade the ticket behind the splash, then show whatever the answer deserves. */
function renderExchange(ticket: string): void {
  // The existing splash covers the wait (a white sheet would read as a broken app).
  root.render(
    <StrictMode>
      <Splash />
    </StrictMode>,
  );
  void exchangeHubTicket(ticket).then((outcome) => {
    if (outcome === 'ok') {
      renderApp();
      return;
    }
    if (outcome === 'down') {
      // Retry re-posts the SAME ticket, which is still in memory — no reload
      // (a reload would lose it: the fragment is wiped on the first line of the
      // boot). If those 60 seconds have run out by then, the server answers 4xx
      // and the next screen is <HubExpired/>, which names the only cure left.
      root.render(
        <StrictMode>
          <HubDown onRetry={() => renderExchange(ticket)} />
        </StrictMode>,
      );
      return;
    }
    root.render(
      <StrictMode>
        <HubExpired />
      </StrictMode>,
    );
  });
}

if (mode === 'hub') {
  // Three ways a shell launch can start, decided in one place (lib/hubGate.ts):
  //   'app'      — this tab already holds a live pass (a reload inside the shell);
  //   'exchange' — first load: a ticket to trade before any screen is shown;
  //   'expired'  — neither. The pass is gone or out of date and the ticket was
  //                spent long ago, so there is nothing left to sign in with.
  //                NOT the landing page: "Open in Telegram" is a dead end here,
  //                and the visitor did nothing wrong.
  const ticket = hubTicketFromLaunch();
  const entry = hubEntry(Boolean(readLiveHubPass()), Boolean(ticket));
  if (entry === 'app') {
    renderApp();
  } else if (entry === 'exchange' && ticket) {
    renderExchange(ticket);
  } else {
    root.render(
      <StrictMode>
        <HubExpired />
      </StrictMode>,
    );
  }
} else {
  root.render(<StrictMode>{outside ? <OutsideTelegram /> : <App />}</StrictMode>);
}
