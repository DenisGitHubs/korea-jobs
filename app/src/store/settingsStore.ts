import { create } from 'zustand';
import i18n, { type Lang } from '../i18n';
import { applyThemeMode, type ThemeMode } from '../lib/theme';

const LANG_KEY = 'kj:lang';
const THEME_KEY = 'kj:theme';

export function loadStoredLang(): Lang | null {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === 'en' || v === 'ru' ? v : null;
  } catch {
    return null;
  }
}

export function loadStoredThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'auto' || v === 'light' || v === 'dark') return v;
  } catch {
    /* storage blocked */
  }
  // Dark is the product's primary theme: default to forced dark when the user
  // has not chosen otherwise. 'auto'/'light' stay available in Settings and,
  // once picked, are persisted and override this default.
  return 'dark';
}

interface SettingsState {
  lang: Lang;
  themeMode: ThemeMode;
  /** True inside a real Telegram client; false in the browser mock. */
  isReal: boolean;
  /** Telegram @username (no @), for prefilling contact fields. */
  username: string;
  init: (p: { lang: Lang; isReal: boolean; username?: string; themeMode?: ThemeMode }) => void;
  setLang: (l: Lang) => void;
  setThemeMode: (m: ThemeMode) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  lang: 'ru',
  themeMode: 'dark',
  isReal: false,
  username: '',
  init: ({ lang, isReal, username = '', themeMode = 'dark' }) =>
    set({ lang, isReal, username, themeMode }),
  setLang: (l) => {
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      /* storage blocked — keep in-memory only */
    }
    void i18n.changeLanguage(l);
    set({ lang: l });
  },
  setThemeMode: (m) => {
    try {
      localStorage.setItem(THEME_KEY, m);
    } catch {
      /* storage blocked */
    }
    applyThemeMode(m);
    set({ themeMode: m });
  },
}));
