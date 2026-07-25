import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Subscription, VisaType, WorkType } from '../shared/types/api';
import { VISA_TYPES, WORK_TYPES, visaKey, workTypeKey } from '../shared/labels';
import { WorkTypeIcon } from './icons/WorkTypeIcon';
import { api } from '../shared/api/client';
import { subscriptionValue, useSubscriptionStore } from '../store/subscriptionStore';
import { useUiStore } from '../store/uiStore';
import { filterFromSubscription, useFilterStore } from '../store/filterStore';
import { ChipSelect, type ChipOption } from './ChipSelect';
import { Switch } from './Switch';

function MarkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="18" height="12" x="3" y="8" rx="2" />
      <path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M3 13h18" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

const FEAT_ICONS: ReactNode[] = [
  <svg key="a" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect width="8" height="4" x="8" y="2" rx="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <path d="M12 11h4" />
    <path d="M12 16h4" />
    <path d="M8 11h.01" />
    <path d="M8 16h.01" />
  </svg>,
  <svg key="b" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 5h18l-7 8.2V19l-4 2v-7.8z" />
  </svg>,
  <svg key="c" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>,
];

/**
 * First-run onboarding overlay. Shown once when `me.onboarded === false`; mounts
 * full-screen over the shell (TabBar hidden). Finishing persists the chosen
 * subscription then POST /onboarded; Skip just POST /onboarded. Both open the feed.
 */
export function Onboarding() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const onboarded = useSubscriptionStore((s) => s.onboarded);
  const setOnboarded = useSubscriptionStore((s) => s.setOnboarded);
  const applySub = useSubscriptionStore((s) => s.apply);
  const termsRequired = useSubscriptionStore((s) => s.termsRequired);
  const setTabBarHidden = useUiStore((s) => s.setTabBarHidden);

  // Never collect preferences before consent: onboarding waits until the terms
  // are accepted (ConsentGate clears termsRequired first).
  const show = onboarded === false && !termsRequired;

  const [step, setStep] = useState(0); // 0 welcome · 1 work · 2 visa · 3 notify · 4 done
  const [workTypes, setWorkTypes] = useState<WorkType[]>([]);
  const [visa, setVisa] = useState<VisaType[]>([]);
  // Owner rule (2026-07-25): notifications are OPT-IN — the toggle starts OFF, so
  // nobody is subscribed to DMs by a pre-checked box they never touched.
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);

  // Hide the TabBar while the overlay is up (restored on close/unmount).
  useEffect(() => {
    setTabBarHidden(show);
    return () => setTabBarHidden(false);
  }, [show, setTabBarHidden]);

  const workOptions = useMemo<ChipOption<WorkType>[]>(
    () => WORK_TYPES.map((w) => ({ value: w, label: t(workTypeKey(w)), icon: <WorkTypeIcon type={w} /> })),
    [t],
  );
  const visaOptions = useMemo<ChipOption<VisaType>[]>(
    () => VISA_TYPES.map((v) => ({ value: v, label: t(visaKey(v)) })),
    [t],
  );

  const close = useCallback(
    (to = '/feed') => {
      setOnboarded();
      navigate(to);
    },
    [setOnboarded, navigate],
  );

  const finish = useCallback(
    async (to = '/feed') => {
      if (busy) return;
      setBusy(true);
    const sub: Subscription = {
      city_slugs: [],
      work_types: workTypes,
      notify,
      // ALWAYS sent explicitly: an omitted field used to be read as "on" by the
      // server, which switched the daily digest on for people who had just turned
      // notifications off. Onboarding has a single "send me jobs" question, so the
      // digest mirrors that answer; both are editable in Settings afterwards.
      digest_enabled: notify,
      // notify_daily_cap is DELIBERATELY not sent here. A brand-new row gets NULL
      // — no cap, per the owner's rule that nobody is throttled until they ask to
      // be — and an absent field keeps the stored cap, so running through
      // onboarding again cannot overwrite a choice already made. The cap lives in
      // Settings, under the mailing toggle.
      visa_types: visa,
      placement_fee: null,
      require_housing: null,
      require_meals: null,
    };
    try {
      const saved = await api.saveSubscription(sub);
      applySub(saved);
      // Immediate payoff: tune the feed to the fresh subscription.
      useFilterStore.getState().apply(filterFromSubscription(subscriptionValue(useSubscriptionStore.getState())));
    } catch {
      /* subscription save is non-blocking — still finish onboarding */
    }
    try {
      await api.markOnboarded();
    } catch {
      /* offline — close anyway so the user is never trapped */
    }
    setBusy(false);
    close(to);
  }, [busy, workTypes, visa, notify, applySub, close]);

  const skip = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.markOnboarded();
    } catch {
      /* ignore */
    }
    setBusy(false);
    close();
  }, [busy, close]);

  if (!show) return null;

  const isQuiz = step >= 1 && step <= 3;

  return (
    <div className="onb" role="dialog" aria-modal="true">
      {isQuiz ? (
        <div className="onb__top">
          <div className="onb__dots" aria-hidden>
            {[1, 2, 3].map((s) => (
              <span key={s} className={`onb__dot ${step === s ? 'onb__dot--on' : ''}`} />
            ))}
          </div>
          <button className="onb__skip" onClick={skip} disabled={busy}>
            {t('onb.skip')}
          </button>
        </div>
      ) : null}

      <div className="onb__body">
        <div className="onb__step" key={step}>
          {step === 0 ? (
            <div className="onb__welcome">
              <div className="onb__mark">
                <MarkIcon />
              </div>
              <h1 className="onb__title">{t('onb.welcomeTitle')}</h1>
              <p className="onb__lead">{t('onb.welcomeLead')}</p>
              <div className="onb__feats">
                {[t('onb.feat1'), t('onb.feat2'), t('onb.feat3')].map((label, i) => (
                  <div className="onb__feat" key={label}>
                    <span className="onb__feat-ico">{FEAT_ICONS[i]}</span>
                    <span className="onb__feat-t">{label}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <>
              <h2 className="onb__q">{t('onb.workTitle')}</h2>
              <p className="onb__hint">{t('onb.workHint')}</p>
              <ChipSelect grid className="chips--onb" options={workOptions} value={workTypes} onChange={setWorkTypes} />
            </>
          ) : null}

          {step === 2 ? (
            <>
              <h2 className="onb__q">{t('onb.visaTitle')}</h2>
              <p className="onb__hint">{t('onb.visaHint')}</p>
              <ChipSelect grid={2} className="chips--onb" options={visaOptions} value={visa} onChange={setVisa} />
            </>
          ) : null}

          {step === 3 ? (
            <>
              <h2 className="onb__q">{t('onb.notifyTitle')}</h2>
              <p className="onb__hint">{t('onb.notifyHint')}</p>
              <div className="section">
                <div className="row">
                  <div className="row__label">{t('onb.notifyToggle')}</div>
                  <Switch checked={notify} onChange={setNotify} label={t('onb.notifyToggle')} />
                </div>
              </div>
            </>
          ) : null}

          {step === 4 ? (
            <div className="onb__done">
              <div className="onb__check">
                <CheckIcon />
              </div>
              <h1 className="onb__title">{t('onb.doneTitle')}</h1>
              <p className="onb__lead">{t('onb.doneLead')}</p>
              <div className="onb__sum">
                {workTypes.map((w) => (
                  <span key={w} className="badge badge--work">
                    {t(workTypeKey(w))}
                  </span>
                ))}
                {visa.length ? <span className="badge badge--perk">{t('onb.sumVisa')}</span> : null}
                {!workTypes.length && !visa.length ? <span className="badge">{t('onb.sumAll')}</span> : null}
                <span className="badge">{notify ? t('onb.sumNotifyOn') : t('onb.sumNotifyOff')}</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="onb__foot">
        {step === 0 ? (
          <>
            <button className="btn btn--primary btn--block" onClick={() => setStep(1)}>
              {t('onb.start')}
            </button>
            <button className="btn btn--ghost btn--block" onClick={skip} disabled={busy}>
              {t('onb.skip')}
            </button>
          </>
        ) : null}

        {isQuiz ? (
          <button className="btn btn--primary btn--block" onClick={() => setStep(step + 1)}>
            {t('onb.next')}
          </button>
        ) : null}

        {step === 4 ? (
          <>
            <button className="btn btn--primary btn--block" onClick={() => finish('/feed')} disabled={busy}>
              {busy ? t('common.saving') : t('onb.doneCta')}
            </button>
            <button className="btn btn--ghost btn--block" onClick={() => finish('/safety')} disabled={busy}>
              {t('safety.link')}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
