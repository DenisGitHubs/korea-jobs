import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../shared/api/client';
import { useSettingsStore } from '../store/settingsStore';
import { AppBar } from '../components/AppBar';
import { Field } from '../components/Field';
import { EmptyState } from '../components/EmptyState';

export default function PartnersScreen() {
  const { t } = useTranslation();
  const username = useSettingsStore((s) => s.username);

  const [message, setMessage] = useState('');
  const [contact, setContact] = useState(username ? `@${username}` : '');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const canSend = message.trim().length > 0 || contact.trim().length > 0;

  const send = useCallback(async () => {
    if (!canSend || sending) return;
    setSending(true);
    try {
      await api.cooperation({
        contact: contact.trim() || undefined,
        message: message.trim() || undefined,
      });
      setSent(true);
    } catch {
      /* leave the form so the user can retry */
    } finally {
      setSending(false);
    }
  }, [canSend, sending, contact, message]);

  if (sent) {
    return (
      <div className="app">
        <AppBar title={t('partners.title')} />
        <div className="screen">
          <EmptyState emoji="🤝" title={t('partners.sentTitle')} subtitle={t('partners.sentSubtitle')} />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <AppBar title={t('partners.title')} />
      <div className="screen">
        <div className="hero">
          <h1 className="hero__title">{t('partners.heroTitle')}</h1>
          <p className="hero__sub">{t('partners.heroText')}</p>
        </div>

        <div className="stack">
          <Field
            label={t('partners.messageLabel')}
            value={message}
            onChange={setMessage}
            placeholder={t('partners.messagePlaceholder')}
            multiline
            rows={5}
            maxLength={1000}
          />
          <Field
            label={t('partners.contactLabel')}
            value={contact}
            onChange={setContact}
            placeholder={t('partners.contactPlaceholder')}
            hint={t('partners.contactHint')}
          />
          <button className="btn btn--primary btn--block" onClick={send} disabled={!canSend || sending}>
            {sending ? t('common.saving') : t('partners.send')}
          </button>
        </div>
      </div>
    </div>
  );
}
