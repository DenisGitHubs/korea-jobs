import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { findPhone, findTelegramUsername, splitContacts } from '../lib/contacts';

interface ContactLinesProps {
  /** Raw contact field; may pack several contacts joined by ' · '. */
  value: string;
  /** Open a Telegram chat with the given bare username (platform-aware; caller provides). */
  onTelegram: (username: string) => void;
}

/**
 * Renders one row per contact packed into `value`. A phone gets a "call" action
 * (tel:), an @handle a "message on Telegram" action, everything else stays plain
 * text. Each row copies its own line; with 2+ rows a "copy all" copies the whole
 * field. A single contact is rendered by the caller's existing block — this
 * component covers the multi-contact case (but is safe for one row too).
 */
export function ContactLines({ value, onTelegram }: ContactLinesProps) {
  const { t } = useTranslation();
  const parts = splitContacts(value);
  // Index of the row whose "copied" flash is active; -1 = the "copy all" button.
  const [copied, setCopied] = useState<number | null>(null);

  const copy = useCallback((text: string, idx: number) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(idx);
        window.setTimeout(() => setCopied((c) => (c === idx ? null : c)), 1500);
      })
      .catch(() => {
        /* clipboard blocked — ignore */
      });
  }, []);

  return (
    <div className="contacts">
      {parts.map((part, i) => {
        const tg = findTelegramUsername(part);
        const tel = tg ? null : findPhone(part);
        return (
          <div className="contact-line" key={`${i}-${part}`}>
            <span className="contact__value">{part}</span>
            <div className="contact-line__actions">
              {tg ? (
                <button className="btn btn--tg" onClick={() => onTelegram(tg)}>
                  {t('contact.writeTelegram')}
                </button>
              ) : tel ? (
                <a className="btn btn--tg" href={`tel:${tel}`}>
                  {t('contact.call')}
                </a>
              ) : null}
              <button className="btn btn--secondary" onClick={() => copy(part, i)}>
                {copied === i ? t('vacancy.copied') : t('vacancy.copy')}
              </button>
            </div>
          </div>
        );
      })}
      {parts.length > 1 ? (
        <button className="btn btn--secondary btn--block" onClick={() => copy(value, -1)}>
          {copied === -1 ? t('vacancy.copied') : t('contact.copyAll')}
        </button>
      ) : null}
    </div>
  );
}
