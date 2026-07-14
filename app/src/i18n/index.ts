import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ru } from './ru';
import { en } from './en';

export const SUPPORTED_LANGS = ['ru', 'en'] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

/** Map a Telegram/browser language code to one of our supported UI languages. */
export function normalizeLang(code: string | undefined | null): Lang {
  if (code && code.toLowerCase().startsWith('en')) return 'en';
  return 'ru';
}

export function setupI18n(lng: Lang): typeof i18n {
  if (!i18n.isInitialized) {
    void i18n.use(initReactI18next).init({
      resources: {
        ru: { translation: ru },
        en: { translation: en },
      },
      lng,
      fallbackLng: 'ru',
      interpolation: { escapeValue: false },
      returnNull: false,
    });
  } else if (i18n.language !== lng) {
    void i18n.changeLanguage(lng);
  }
  return i18n;
}

export default i18n;
