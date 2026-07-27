import type { Lang } from '../../i18n';

/**
 * Structured legal-document content. Kept OUT of the i18n bundle on purpose: these
 * are long RU/EN texts, so storing them as plain data here avoids bloating the
 * i18n key-parity type (`en: typeof ru`). Each doc still carries both languages.
 *
 * The only inline markup is `**bold**` (see components/LegalDoc.tsx); a lone
 * asterisk is rendered literally.
 */
export type LegalBlock =
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] };

export interface LegalSection {
  /** Section heading (kept 1:1 with the approved source text). */
  heading?: string;
  blocks: LegalBlock[];
}

export interface LegalDoc {
  /** Version + effective-date meta line, shown under the title. */
  meta: string;
  /** Plain-language note (tone + where to write) shown at the very top of the screen. */
  intro: string;
  sections: LegalSection[];
}

export type LegalDocByLang = Record<Lang, LegalDoc>;
