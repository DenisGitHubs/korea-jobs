import type { Lang } from '../../i18n';

/**
 * Structured legal-document content. Kept OUT of the i18n bundle on purpose: these
 * are long RU/EN texts, so storing them as plain data here avoids bloating the
 * i18n key-parity type (`en: typeof ru`). Each doc still carries both languages.
 *
 * Text may use `**bold**`. Placeholders authored as `*[...]*` (single asterisks)
 * are intentionally NOT markup — they render literally so the owner can spot and
 * fill them (see components/LegalDoc.tsx).
 */
export type LegalBlock =
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] };

export interface LegalSection {
  /** Section heading (kept 1:1 with the source draft). */
  heading?: string;
  blocks: LegalBlock[];
}

export interface LegalDoc {
  /** Version + effective-date meta line, shown under the title. */
  meta: string;
  /** Draft banner shown at the very top of the screen. */
  draftNote: string;
  sections: LegalSection[];
}

export type LegalDocByLang = Record<Lang, LegalDoc>;
