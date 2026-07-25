import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSubscriptionStore } from '../store/subscriptionStore';

/** localStorage flag (same convention as kj:refBannerDismissed) — dismiss is sticky. */
const DISMISS_KEY = 'kj:notifyNudgeDismissed';

function loadDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/**
 * Soft opt-in offer for the job mailing, slipped INTO the feed list (not a modal,
 * not a top banner): the caller renders it a few cards down, so it is met after the
 * user has scrolled a bit rather than on the very first screen.
 *
 * Shown only while the mailing is actually off — `notify` comes from the already
 * loaded /me profile (subscription store), so there is no extra request; switching
 * it on in Settings makes the nudge disappear on the next render. ✕ hides it for
 * good (localStorage).
 *
 * "Настроить" opens Settings with ?focus=notify, which scrolls the mailing toggle
 * to the middle of the screen and briefly highlights it.
 */
export function NotifyNudge() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const loaded = useSubscriptionStore((s) => s.loaded);
  const notify = useSubscriptionStore((s) => s.notify);
  const [dismissed, setDismissed] = useState<boolean>(loadDismissed);

  if (!loaded || notify || dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* storage blocked — hide for this session only */
    }
    setDismissed(true);
  };

  return (
    <div className="nudge-notify" role="note">
      <span className="nudge-notify__icon" aria-hidden>
        <BellIcon />
      </span>
      <span className="nudge-notify__text">
        <span className="nudge-notify__title">{t('feed.notifyNudge.title')}</span>
        <span className="nudge-notify__sub">{t('feed.notifyNudge.sub')}</span>
      </span>
      <button className="nudge-notify__cta" onClick={() => navigate('/settings?focus=notify')}>
        {t('feed.notifyNudge.cta')}
      </button>
      <button className="nudge-notify__close" onClick={dismiss} aria-label={t('feed.notifyNudge.close')}>
        <span aria-hidden>✕</span>
      </button>
    </div>
  );
}
