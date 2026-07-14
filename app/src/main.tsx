import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { bootstrapTelegram } from './lib/telegram';
import { initTheme } from './lib/theme';
import { normalizeLang, setupI18n } from './i18n';
import { loadStoredLang, useSettingsStore } from './store/settingsStore';
import App from './App';
import './index.css';

// Side-effect bootstrap BEFORE React mounts.
const ctx = bootstrapTelegram();
initTheme();

const lang = loadStoredLang() ?? normalizeLang(ctx.languageCode);
setupI18n(lang);
useSettingsStore.getState().init({ lang, isReal: ctx.isReal });

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
