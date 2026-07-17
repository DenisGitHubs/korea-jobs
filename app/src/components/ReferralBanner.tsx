import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/** localStorage flag (same convention as kj:lang / kj:theme) — dismiss is sticky. */
const DISMISS_KEY = 'kj:refBannerDismissed';

function loadDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/** Dismissible invite CTA shown above the feed. Navigates to the referral screen. */
export function ReferralBanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState<boolean>(loadDismissed);

  if (dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* storage blocked — hide for this session only */
    }
    setDismissed(true);
  };

  return (
    <div className="ref-banner">
      <button className="ref-banner__body" onClick={() => navigate('/referral')}>
        <span className="ref-banner__emoji" aria-hidden>
          🤝
        </span>
        <span className="ref-banner__text">
          <span className="ref-banner__title">{t('feed.inviteBannerTitle')}</span>
          <span className="ref-banner__cta">{t('feed.inviteBannerCta')} ›</span>
        </span>
      </button>
      <button className="ref-banner__close" onClick={dismiss} aria-label={t('feed.inviteBannerClose')}>
        <span aria-hidden>✕</span>
      </button>
    </div>
  );
}
