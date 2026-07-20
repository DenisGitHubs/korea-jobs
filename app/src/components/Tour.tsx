import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSubscriptionStore } from '../store/subscriptionStore';
import { useUiStore } from '../store/uiStore';

/**
 * Lightweight 3-slide "how it works" tour, shown ONCE after onboarding for a
 * first-time user (localStorage flag), and replayable from Settings ("How to
 * use"). Deliberately short — a full-screen overlay reusing the onboarding
 * chrome (.onb*), one icon + one line per slide, skippable on every step.
 */
const TOUR_KEY = 'kj:tour:v1';

function tourSeen(): boolean {
  try {
    return localStorage.getItem(TOUR_KEY) === 'done';
  } catch {
    return false;
  }
}

function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_KEY, 'done');
  } catch {
    /* storage blocked — show at most once per session anyway */
  }
}

interface Slide {
  icon: ReactNode;
  titleKey: string;
  leadKey: string;
}

// 1) browse + reach the employer · 2) tune filters/alerts · 3) post + share.
const SLIDES: Slide[] = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        <path d="M8 9h8" />
        <path d="M8 13h5" />
      </svg>
    ),
    titleKey: 'tour.s1.title',
    leadKey: 'tour.s1.lead',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 6h18" />
        <path d="M7 12h10" />
        <path d="M10 18h4" />
      </svg>
    ),
    titleKey: 'tour.s2.title',
    leadKey: 'tour.s2.lead',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M22 2 11 13" />
        <path d="M22 2 15 22l-4-9-9-4z" />
      </svg>
    ),
    titleKey: 'tour.s3.title',
    leadKey: 'tour.s3.lead',
  },
];

export function Tour() {
  const { t } = useTranslation();
  const onboarded = useSubscriptionStore((s) => s.onboarded);
  const termsRequired = useSubscriptionStore((s) => s.termsRequired);
  const replay = useUiStore((s) => s.tourReplay);
  const setReplay = useUiStore((s) => s.setTourReplay);
  const setTabBarHidden = useUiStore((s) => s.setTabBarHidden);

  const [seen, setSeen] = useState(tourSeen);
  const [step, setStep] = useState(0);

  // First run: only after consent + onboarding are done, and never seen before.
  const firstRun = onboarded === true && !termsRequired && !seen;
  const show = replay || firstRun;

  // Hide the TabBar while the overlay is up (restored on close/unmount).
  useEffect(() => {
    setTabBarHidden(show);
    return () => setTabBarHidden(false);
  }, [show, setTabBarHidden]);

  // Always start from the first slide when the overlay (re)opens.
  useEffect(() => {
    if (show) setStep(0);
  }, [show]);

  const close = useCallback(() => {
    markTourSeen();
    setSeen(true);
    setReplay(false);
  }, [setReplay]);

  if (!show) return null;

  const isLast = step === SLIDES.length - 1;
  const slide = SLIDES[step];

  return (
    <div className="onb" role="dialog" aria-modal="true">
      <div className="onb__top">
        <div className="onb__dots" aria-hidden>
          {SLIDES.map((_, i) => (
            <span key={i} className={`onb__dot ${step === i ? 'onb__dot--on' : ''}`} />
          ))}
        </div>
        <button className="onb__skip" onClick={close}>
          {t('tour.skip')}
        </button>
      </div>

      <div className="onb__body">
        <div className="onb__step" key={step}>
          <div className="onb__welcome">
            <div className="onb__mark">{slide.icon}</div>
            <h1 className="onb__title">{t(slide.titleKey)}</h1>
            <p className="onb__lead">{t(slide.leadKey)}</p>
          </div>
        </div>
      </div>

      <div className="onb__foot">
        {isLast ? (
          <button className="btn btn--primary btn--block" onClick={close}>
            {t('tour.done')}
          </button>
        ) : (
          <button className="btn btn--primary btn--block" onClick={() => setStep(step + 1)}>
            {t('tour.next')}
          </button>
        )}
      </div>
    </div>
  );
}
