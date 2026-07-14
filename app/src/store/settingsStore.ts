import { create } from 'zustand';
import i18n, { type Lang } from '../i18n';

const LANG_KEY = 'kj:lang';

export function loadStoredLang(): Lang | null {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === 'en' || v === 'ru' ? v : null;
  } catch {
    return null;
  }
}

interface SettingsState {
  lang: Lang;
  /** True inside a real Telegram client; false in the browser mock. */
  isReal: boolean;
  init: (p: { lang: Lang; isReal: boolean }) => void;
  setLang: (l: Lang) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  lang: 'ru',
  isReal: false,
  init: ({ lang, isReal }) => set({ lang, isReal }),
  setLang: (l) => {
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      /* storage blocked — keep in-memory only */
    }
    void i18n.changeLanguage(l);
    set({ lang: l });
  },
}));
