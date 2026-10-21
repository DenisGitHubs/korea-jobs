import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../shared/api/client';
import { AppBar } from '../components/AppBar';
import { Field } from '../components/Field';
import { Sheet } from '../components/Sheet';
import { EmptyState } from '../components/EmptyState';
import { IconBriefcase, IconMegaphone, IconSent, IconTicketPercent } from '../components/icons/StateIcons';
import { PLACEMENT_RULES_PATH } from '../content/legal/paths';

/**
 * Non-tappable partnership card: icon disc + title/audience, a body paragraph,
 * optional small notes, and an OPTIONAL neutral "let's discuss" chip. A plain `<div>` on
 * purpose — the whole card is not a control; the only interactive element is the
 * optional inline link (promo → referral).
 */
function PartnerCard({
  icon,
  title,
  audience,
  headBadge,
  children,
  footLabel,
}: {
  icon: ReactNode;
  title: string;
  audience: string;
  headBadge?: string;
  children: ReactNode;
  footLabel?: string;
}) {
  return (
    <div className="partner-card">
      <div className="partner-card__head">
        <span className="partner-card__icon" aria-hidden>
          {icon}
        </span>
        <div className="partner-card__titles">
          <div className="partner-card__title">{title}</div>
          <div className="partner-card__audience">{audience}</div>
        </div>
        {headBadge ? <span className="badge badge--source">{headBadge}</span> : null}
      </div>
      {children}
      {/* The chip is optional: on the vacancies card there is no format left to
          discuss — the week at the top is the same for everyone. */}
      {footLabel ? (
        <div className="partner-card__foot">
          <span className="badge badge--source">{footLabel}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One phrase of a note turned into a link to the Placement Rules. The phrase is the
 * document's OWN title, lowercased — i.e. the exact words already standing in the
 * sentence, never a label invented here. If the sentence stops containing the phrase
 * (the text gets rewritten) the note falls back to PLAIN TEXT — it still reads
 * correctly, and the guard goes red instead of the screen showing broken markup.
 */
function NoteWithRules({ text, phrase, onOpen }: { text: string; phrase: string; onOpen: () => void }) {
  const at = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <button type="button" className="inline-link" onClick={onOpen}>
        {text.slice(at, at + phrase.length)}
      </button>
      {text.slice(at + phrase.length)}
    </>
  );
}

/**
 * The "Промокоды за баллы" card is PARKED (owner, 21.10.2026): points and the
 * referral programme stay exactly as they are — only this partnership offer leaves
 * the screen. Flip to `true` to bring the card back: one line, and the dictionary
 * keys (`partners.promo.*`) are left in place, untouched.
 */
const SHOW_PROMO_CARD: boolean = false;

export default function PartnersScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [formOpen, setFormOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);

  const canSend = message.trim().length > 0;

  const send = useCallback(async () => {
    if (!canSend || sending) return;
    setSending(true);
    setFailed(false);
    try {
      // The author's Telegram handle comes from the verified initData on the
      // backend (authenticate()), so we no longer collect it in the form. The
      // `contact` field is optional in the contract — we simply omit it.
      await api.cooperation({
        message: message.trim() || undefined,
      });
      // Success: dismiss the sheet and swap the page for the "sent" state.
      setFormOpen(false);
      setSent(true);
    } catch {
      // Keep the sheet open with the text intact AND say so: a silent no-op
      // reads as "the button is broken", and a partner who thinks they wrote
      // to us simply never writes again.
      setFailed(true);
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

        {/* Who we are (and who we are not) — stated up front, in a confident tone. */}
        <div className="partners-status">
          <p className="partners-status__line">{t('partners.disclaimer.status')}</p>
          <p className="partners-status__line">{t('partners.disclaimer.free')}</p>
        </div>

        <div className="region">
          <div className="region__title">{t('partners.sectionTitle')}</div>

          <PartnerCard
            icon={<IconBriefcase />}
            title={t('partners.jobs.title')}
            audience={t('partners.jobs.audience')}
          >
            <p className="partner-card__body">{t('partners.jobs.body')}</p>
            <p className="partner-card__note">{t('partners.jobs.featuredNote')}</p>
            <p className="partner-card__note">
              <NoteWithRules
                text={t('partners.jobs.featuredTerms')}
                phrase={t('placementRules.title')}
                onOpen={() => navigate(PLACEMENT_RULES_PATH)}
              />
            </p>
            <p className="partner-card__note">{t('partners.jobs.agencyNote')}</p>
          </PartnerCard>

          {SHOW_PROMO_CARD ? (
            <PartnerCard
              icon={<IconTicketPercent />}
              title={t('partners.promo.title')}
              audience={t('partners.promo.audience')}
              footLabel={t('partners.discussFormat')}
            >
              <p className="partner-card__body">{t('partners.promo.body')}</p>
              <p className="partner-card__body">{t('partners.promo.benefit')}</p>
              <p className="partner-card__note">{t('partners.promo.pointsNote')}</p>
              {/* Compact nav row (Settings recipe) — where the points come from. */}
              <button className="partner-card__link" onClick={() => navigate('/referral')}>
                <span className="partner-card__link-label">{t('partners.promo.link')}</span>
                <span className="row__chevron" aria-hidden>
                  ›
                </span>
              </button>
            </PartnerCard>
          ) : null}

          <PartnerCard
            icon={<IconMegaphone />}
            title={t('partners.ads.title')}
            audience={t('partners.ads.audience')}
            headBadge={t('partners.ads.badge')}
            footLabel={t('partners.discussFormat')}
          >
            <p className="partner-card__body">{t('partners.ads.body')}</p>
            <p className="partner-card__note">{t('partners.ads.disclaimer')}</p>
          </PartnerCard>
        </div>

        {/* Fine print for all three options — kept in one place, not repeated per card. */}
        <div className="partners-fine">
          <p>{t('partners.disclaimer.adsMark')}</p>
        </div>

        <button className="btn btn--primary btn--block" onClick={() => setFormOpen(true)}>
          {t('partners.cta')}
        </button>
      </div>

      {/* The form lives in the shared bottom sheet; Send sits in the sheet footer so
          the on-screen keyboard never covers it. */}
      <Sheet
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={t('partners.form.title')}
        footer={
          <>
            {failed ? (
              <p className="consent__error" role="alert">
                {t('partners.form.error')}
              </p>
            ) : null}
            <button className="btn btn--primary btn--block" onClick={send} disabled={!canSend || sending}>
              {sending ? t('common.saving') : failed ? t('common.retry') : t('partners.form.send')}
            </button>
          </>
        }
      >
        <p className="partners-form__sub">{t('partners.form.subtitle')}</p>
        <Field
          label={t('partners.form.messageLabel')}
          value={message}
          onChange={setMessage}
          placeholder={t('partners.form.messagePlaceholder')}
          multiline
          rows={5}
          maxLength={1000}
        />
      </Sheet>
    </div>
  );
}
