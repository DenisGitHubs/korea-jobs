import { useCallback, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { api, USE_MOCK } from '../shared/api/client';
import { useSubscriptionStore } from '../store/subscriptionStore';

/** Paths where the gate steps aside so the user can read the linked documents. */
const DOC_PATHS = ['/privacy', '/rules'];

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * Consent gate shown BEFORE onboarding whenever the current terms are not yet
 * accepted (`termsRequired`). Blocks the app until the user actively ticks an
 * unchecked-by-default box (18+, Rules + Privacy, cross-border transfer) and taps
 * Continue, which records acceptance via POST /api/terms/accept. It steps aside
 * on /privacy and /rules so the linked documents are readable, then reappears.
 *
 * This is the single terms surface (it replaced the old Layout terms modal); the
 * notifications toggle stays a separate opt-in inside onboarding.
 */
export function ConsentGate() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const termsRequired = useSubscriptionStore((s) => s.termsRequired);
  const acceptLocal = useSubscriptionStore((s) => s.acceptTerms);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const accept = useCallback(() => {
    if (!checked || busy) return;
    setBusy(true);
    setFailed(false);
    api
      .acceptTerms()
      .then(() => {
        // Server recorded the acceptance — now reflect it locally and pass the gate.
        acceptLocal();
      })
      .catch(() => {
        if (USE_MOCK) {
          // Mock/dev has no backend to record consent; accept locally so the UI flows.
          acceptLocal();
          return;
        }
        // Real API error: FAIL CLOSED. Do NOT pass the gate — surface an error and let
        // the user retry so mandatory consent is never silently skipped.
        setFailed(true);
      })
      .finally(() => {
        setBusy(false);
      });
  }, [checked, busy, acceptLocal]);

  if (!termsRequired) return null;
  // Let the user read the linked Privacy / Rules documents underneath.
  if (DOC_PATHS.includes(pathname)) return null;

  return (
    <div className="onb consent" role="dialog" aria-modal="true">
      <div className="onb__body">
        <div className="onb__step">
          <div className="consent__mark" aria-hidden>
            <ShieldIcon />
          </div>
          <h1 className="onb__title">{t('consent.title')}</h1>
          <p className="onb__lead">{t('consent.lead')}</p>

          <label className="consent__check">
            <input
              type="checkbox"
              className="consent__input"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            <span className="consent__box" aria-hidden>
              <CheckIcon />
            </span>
            <span className="consent__text">
              <Trans
                i18nKey="consent.agree"
                components={{
                  rules: <Link className="consent__link" to="/rules" />,
                  privacy: <Link className="consent__link" to="/privacy" />,
                }}
              />
            </span>
          </label>
        </div>
      </div>

      <div className="onb__foot">
        {failed ? (
          <p className="consent__error" role="alert">
            {t('consent.error')}
          </p>
        ) : null}
        <button
          className="btn btn--primary btn--block"
          onClick={accept}
          disabled={!checked || busy}
        >
          {busy ? t('common.saving') : failed ? t('common.retry') : t('consent.continue')}
        </button>
      </div>
    </div>
  );
}
