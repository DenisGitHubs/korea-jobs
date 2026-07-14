import type { Localized } from '../shared/types/api';
import type { Lang } from '../i18n';

/** Pick the best available localized string for the current UI language. */
export function localized(name: Localized | undefined | null, lang: Lang): string {
  if (!name) return '';
  return name[lang] || name.en || name.ru || '';
}
