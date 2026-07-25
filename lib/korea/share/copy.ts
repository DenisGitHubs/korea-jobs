// lib/korea/share/copy.ts
//
// SINGLE source of ALL user-visible text on the share cards — both the "share a vacancy" card
// and the "share the app" (invite) card. Isolated on purpose so a legal review (Законник) can
// edit copy in ONE place without touching handler logic. RU is the default; EN is served to
// en-* locales (matching the audience: RU-speaking workers in Korea, with EN as the only other
// supported card language for now).

export type ShareLocale = 'ru' | 'en';

/** Pick the card locale from a Telegram language_code. Anything non-English falls back to RU. */
export function shareLocale(lang: string | null | undefined): ShareLocale {
  return typeof lang === 'string' && /^en/i.test(lang) ? 'en' : 'ru';
}

/**
 * All share-card copy, per locale. `vacancyTitle` is a template — the {role} is the localized
 * work-type label (core/labels.ts). Everything else is a fixed string. Legal edits happen here.
 */
export const SHARE_COPY: Record<
  ShareLocale,
  {
    appTitle: string;
    appDescription: string;
    appButton: string;
    vacancyTitle: (role: string) => string;
    vacancyButton: string;
  }
> = {
  // LEGAL (Законник): the app card must describe the PROCESS ("we filter suspicious posts"), never
  // promise an OUTCOME/guarantee ("scam-checked", "safe") — the app cannot guarantee that for
  // bot-collected listings. Any future copy here must keep to process wording.
  ru: {
    appTitle: 'Работа в Корее — вакансии для своих',
    appDescription: 'Вакансии в Корее, фильтруем подозрительные объявления. Бесплатно.',
    appButton: 'Открыть приложение',
    vacancyTitle: (role) => `${role} — вакансия в Корее`,
    vacancyButton: 'Открыть вакансию',
  },
  en: {
    appTitle: 'Jobs in Korea — for your own people',
    appDescription: 'Jobs in Korea, we filter suspicious posts. Free.',
    appButton: 'Open app',
    vacancyTitle: (role) => `${role} — job in Korea`,
    vacancyButton: 'Open job',
  },
};
