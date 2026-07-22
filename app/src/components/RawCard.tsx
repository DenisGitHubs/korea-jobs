import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../shared/api/client';
import { useSubscriptionStore } from '../store/subscriptionStore';
import type { RawView } from '../shared/types/api';

/** Phone glyph — mirrors the "show contact" action on the vacancy detail screen. */
function PhoneIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
    </svg>
  );
}

type RevealState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; text: string }
  | { status: 'error'; message: string };

/**
 * A listing the AI could not structure. Amber "unverified" signal, italic
 * scrubbed text, coarse age. The contact is hidden until the user taps
 * "show contact", which fetches the ORIGINAL (unfiltered) text via /raw/reveal
 * — same shared daily budget & 429 handling as the vacancy contact reveal.
 */
export function RawCard({ raw }: { raw: RawView }) {
  const { t } = useTranslation();
  const age = raw.age_hint <= 0 ? t('time.justNow') : t('time.days', { count: raw.age_hint });
  const [reveal, setReveal] = useState<RevealState>({ status: 'idle' });
  // Raw reveals draw from the same daily budget as vacancy contacts — keep the
  // shared counter in sync so the vacancy-screen hint stays accurate.
  const setRevealsLeft = useSubscriptionStore((s) => s.setRevealsLeft);

  const showContact = useCallback(() => {
    setReveal({ status: 'loading' });
    api
      .rawReveal(raw.id)
      .then((r) => {
        setReveal({ status: 'done', text: r.text });
        setRevealsLeft(r.reveals_left);
      })
      .catch((e: unknown) => {
        const http = e instanceof ApiError ? e.http : 0;
        if (http === 429) setRevealsLeft(0);
        const message =
          http === 429
            ? t('raw.errorLimit')
            : http === 404
              ? t('raw.errorGone')
              : t('raw.errorGeneric');
        setReveal({ status: 'error', message });
      });
  }, [raw.id, t, setRevealsLeft]);

  return (
    <div className="card card--raw">
      <div className="card__badges">
        <span className="badge badge--raw">⚠ {t('raw.badge')}</span>
        <span className="card__time">{age}</span>
      </div>
      <div className="card__desc card__desc--raw">{raw.text}</div>

      {reveal.status === 'done' ? (
        <div className="raw-reveal">
          <div className="raw-reveal__text">{reveal.text}</div>
          <div className="raw-reveal__warn">{t('raw.warning')}</div>
        </div>
      ) : (
        <>
          <button
            className="btn btn--primary btn--block raw-reveal__btn"
            onClick={showContact}
            disabled={reveal.status === 'loading'}
          >
            <PhoneIcon />
            {reveal.status === 'loading' ? t('raw.loading') : t('raw.showContact')}
          </button>
          {reveal.status === 'error' ? (
            <div className="raw-reveal__error">{reveal.message}</div>
          ) : null}
        </>
      )}
    </div>
  );
}
