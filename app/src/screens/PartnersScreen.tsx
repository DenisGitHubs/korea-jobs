import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../shared/api/client';
import { AppBar } from '../components/AppBar';
import { Field } from '../components/Field';
import { EmptyState } from '../components/EmptyState';
import { IconSent } from '../components/icons/StateIcons';

export default function PartnersScreen() {
  const { t } = useTranslation();

  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const canSend = message.trim().length > 0;

  const send = useCallback(async () => {
    if (!canSend || sending) return;
    setSending(true);
    try {
      // The author's Telegram handle comes from the verified initData on the
      // backend (authenticate()), so we no longer collect it in the form. The
      // `contact` field is optional in the contract — we simply omit it.
      await api.cooperation({
        message: message.trim() || undefined,
      });
      setSent(true);
    } catch {
      /* leave the form so the user can retry */
    } finally {
      setSending(false);
    }
  }, [canSend, sending, message]);

  if (sent) {
    return (
      <div className="app">
        <AppBar title={t('partners.title')} />
        <div className="screen">
          <EmptyState icon={<IconSent />} title={t('partners.sentTitle')} subtitle={t('partners.sentSubtitle')} />
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
          <button className="btn btn--primary btn--block" onClick={send} disabled={!canSend || sending}>
            {sending ? t('common.saving') : t('partners.send')}
          </button>
        </div>
      </div>
    </div>
  );
}
