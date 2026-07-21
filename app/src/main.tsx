import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { bootstrapTelegram } from './lib/telegram';
import { initTheme } from './lib/theme';
import { normalizeLang, setupI18n } from './i18n';
import { loadStoredLang, loadStoredThemeMode, useSettingsStore } from './store/settingsStore';
import { useFilterStore } from './store/filterStore';
import App from './App';
import './index.css';

// Side-effect bootstrap BEFORE React mounts.
const ctx = bootstrapTelegram();

const themeMode = loadStoredThemeMode();
initTheme(themeMode);

const lang = loadStoredLang() ?? normalizeLang(ctx.languageCode);
setupI18n(lang);
useSettingsStore.getState().init({ lang, isReal: ctx.isReal, username: ctx.username, themeMode });

// Restore a saved feed filter synchronously (like lang/theme above) so the feed's
// first request already carries it — no cold-start race. Nothing saved → the store
// stays uninitialized and the subscription default is seeded after /me hydrates.
useFilterStore.getState().initFromStorage();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
