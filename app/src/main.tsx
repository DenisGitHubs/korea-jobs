import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { bootstrapTelegram } from './lib/telegram';
import { isOutsideTelegram } from './lib/launchEnv';
import { initTheme } from './lib/theme';
import { normalizeLang, setupI18n } from './i18n';
import { loadStoredLang, loadStoredThemeMode, useSettingsStore } from './store/settingsStore';
import { useFilterStore } from './store/filterStore';
import { OutsideTelegram } from './components/OutsideTelegram';
import App from './App';
import './index.css';

// FIRST — before bootstrapTelegram() installs the browser mock, which would make
// every environment look like Telegram. Outside Telegram there is no session to
// load, so we render a static page instead of the app (see lib/launchEnv.ts).
const outside = isOutsideTelegram();

// Side-effect bootstrap BEFORE React mounts — but ONLY inside Telegram.
//
// It must be skipped outside, and not merely because the landing page has no use
// for it: bootstrapTelegram() installs the browser mock (installMock ->
// mockTelegramEnv), and the SDK persists those fake launch params under
// sessionStorage['tapps/launchParams']. That cache is one of the traits
// isOutsideTelegram() reads. Running it here would therefore poison the NEXT
// load of the same tab: first visit -> landing (correct), reload -> the cache
// says "Telegram", the full app mounts, /me answers 401 and the error strip is
// back — exactly the state that got the ad rejected, reachable by pressing F5.
const ctx = outside
  ? { languageCode: undefined, username: undefined, isReal: false }
  : bootstrapTelegram();

// The public page is always dark (it matches the shell index.html pre-paints);
// inside Telegram the user's own theme mode still rules.
const themeMode = loadStoredThemeMode();
initTheme(outside ? 'dark' : themeMode);

// Outside Telegram there is no Telegram account to take a language from — follow
// the browser instead, so a non-Russian visitor gets the page in English.
const lang = loadStoredLang() ?? normalizeLang(outside ? navigator.language : ctx.languageCode);
setupI18n(lang);
useSettingsStore.getState().init({ lang, isReal: ctx.isReal, username: ctx.username, themeMode });

// Restore a saved feed filter synchronously (like lang/theme above) so the feed's
// first request already carries it — no cold-start race. Nothing saved → the store
// stays uninitialized and the subscription default is seeded after /me hydrates.
useFilterStore.getState().initFromStorage();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>{outside ? <OutsideTelegram /> : <App />}</StrictMode>,
);
