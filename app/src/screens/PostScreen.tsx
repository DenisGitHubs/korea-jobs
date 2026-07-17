import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../shared/api/client';
import type { AdInput, ContactKind, PlacementFee, VisaType, WorkType } from '../shared/types/api';
import {
  CONTACT_KINDS,
  PLACEMENT_FEES,
  VISA_TYPES,
  WORK_TYPES,
  WORK_TYPE_EMOJI,
  contactKindKey,
  feeKey,
  visaKey,
  workTypeKey,
} from '../shared/labels';
import { useSettingsStore } from '../store/settingsStore';
import { useBackButton } from '../hooks/useBackButton';
import { useMainButton } from '../hooks/useMainButton';
import { AppBar } from '../components/AppBar';
import { Field } from '../components/Field';
import { Segmented } from '../components/Segmented';
import { ChipSelect, type ChipOption } from '../components/ChipSelect';
import { CityPicker } from '../components/CityPicker';
import { EmptyState } from '../components/EmptyState';

const CONSENT_KEY = 'kj:ads-consent';
const STEP_COUNT = 7;
const LAST = STEP_COUNT - 1;
const MIN_DESC = 15;

type TriState = 'yes' | 'no' | 'unknown';

interface Draft {
  title: string;
  workType: WorkType | null;
  description: string;
  salaryText: string;
  placementFee: PlacementFee;
  feeTerms: string;
  visa: VisaType[];
  city: string | null;
  schedule: string;
  housing: TriState;
  housingTerms: string;
  meals: TriState;
  mealsInfo: string;
  contactRaw: string;
  contactKind: ContactKind;
}

const triToBool = (v: TriState): boolean | null => (v === 'yes' ? true : v === 'no' ? false : null);

function loadConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
}

export default function PostScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const username = useSettingsStore((s) => s.username);

  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<'form' | 'result'>('form');
  const [result, setResult] = useState<'approved' | 'pending' | 'rejected' | null>(null);
  const [rejectReason, setRejectReason] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [consent, setConsent] = useState<boolean>(loadConsent);

  const [d, setD] = useState<Draft>({
    title: '',
    workType: null,
    description: '',
    salaryText: '',
    placementFee: 'unknown',
    feeTerms: '',
    visa: [],
    city: null,
    schedule: '',
    housing: 'unknown',
    housingTerms: '',
    meals: 'unknown',
    mealsInfo: '',
    contactRaw: username ? `@${username}` : '',
    contactKind: username ? 'telegram' : 'phone',
  });
  const patch = useCallback((p: Partial<Draft>) => setD((prev) => ({ ...prev, ...p })), []);

  const stepValid = (s: number): boolean => {
    switch (s) {
      case 0:
        return d.title.trim().length > 0 && d.description.trim().length >= MIN_DESC;
      case 5:
        return d.contactRaw.trim().length > 0;
      case 6:
        return consent;
      default:
        return true;
    }
  };

  const buildInput = (): AdInput => {
    const salary = [d.salaryText.trim(), d.placementFee === 'paid' && d.feeTerms.trim() ? `${t('post.feeTermsShort')}: ${d.feeTerms.trim()}` : '']
      .filter(Boolean)
      .join(' · ');
    return {
      title: d.title.trim(),
      description: d.description.trim(),
      contact_raw: d.contactRaw.trim(),
      contact_kind: d.contactKind,
      work_type: d.workType ?? undefined,
      visa_types: d.visa.length ? d.visa : undefined,
      placement_fee: d.placementFee,
      has_housing: triToBool(d.housing),
      has_meals: triToBool(d.meals),
      salary_text: salary || null,
      housing_terms: d.housing === 'yes' && d.housingTerms.trim() ? d.housingTerms.trim() : null,
      meals_info: d.meals === 'yes' && d.mealsInfo.trim() ? d.mealsInfo.trim() : null,
      schedule: d.schedule.trim() || null,
      city_slug: d.city,
      region_slug: null,
    };
  };

  const publish = useCallback(() => {
    if (submitting) return;
    setSubmitting(true);
    try {
      localStorage.setItem(CONSENT_KEY, '1');
    } catch {
      /* storage blocked */
    }
    api
      .createAd(buildInput())
      .then((r) => {
        setResult(r.status);
        setRejectReason(null);
        setPhase('result');
      })
      .catch(() => {
        setResult('rejected');
        setRejectReason('network');
        setPhase('result');
      })
      .finally(() => setSubmitting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting, d, consent, t]);

  const next = useCallback(() => {
    if (!stepValid(step)) return;
    if (step < LAST) setStep((s) => s + 1);
    else publish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, publish]);

  const back = useCallback(() => {
    if (phase === 'result') {
      navigate('/feed');
      return;
    }
    if (step > 0) setStep((s) => s - 1);
    else navigate('/feed');
  }, [phase, step, navigate]);

  useBackButton(true, back);
  useMainButton({
    text:
      phase === 'result'
        ? t('post.toFeed')
        : step < LAST
          ? t('post.next')
          : submitting
            ? t('common.saving')
            : t('post.publish'),
    visible: true,
    enabled: phase === 'result' ? true : stepValid(step) && !submitting,
    loading: submitting,
    onClick: phase === 'result' ? () => navigate('/feed') : next,
  });

  const isReal = useSettingsStore((s) => s.isReal);

  const workOptions = useMemo<ChipOption<WorkType>[]>(
    () => WORK_TYPES.map((w) => ({ value: w, label: t(workTypeKey(w)), emoji: WORK_TYPE_EMOJI[w] })),
    [t],
  );
  const visaOptions = useMemo<ChipOption<VisaType>[]>(
    () => VISA_TYPES.map((v) => ({ value: v, label: t(visaKey(v)) })),
    [t],
  );
  const contactOptions = useMemo<ChipOption<ContactKind>[]>(
    () => CONTACT_KINDS.map((k) => ({ value: k, label: t(contactKindKey(k)) })),
    [t],
  );
  const triOptions = useMemo(
    () => [
      { value: 'yes' as TriState, label: t('common.yes') },
      { value: 'no' as TriState, label: t('common.no') },
      { value: 'unknown' as TriState, label: t('vacancy.notStated') },
    ],
    [t],
  );

  if (phase === 'result') {
    return (
      <div className="app">
        <AppBar title={t('post.title')} onBack={() => navigate('/feed')} />
        <div className="screen">
          {result === 'approved' ? (
            <EmptyState
              emoji="✅"
              title={t('post.approvedTitle')}
              subtitle={t('post.approvedText')}
              actionLabel={t('post.toFeed')}
              onAction={() => navigate('/feed')}
            />
          ) : result === 'pending' ? (
            <EmptyState
              emoji="🕓"
              title={t('post.pendingTitle')}
              subtitle={t('post.pendingText')}
              actionLabel={t('post.toFeed')}
              onAction={() => navigate('/feed')}
            />
          ) : (
            <EmptyState
              emoji="⚠️"
              title={t('post.rejectedTitle')}
              subtitle={rejectText(rejectReason, t)}
              actionLabel={t('post.edit')}
              onAction={() => setPhase('form')}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <AppBar title={t('post.title')} onBack={back} />
      <div className="screen">
        <div className="steps__head">
          <div className="steps" aria-hidden>
            {Array.from({ length: STEP_COUNT }, (_, i) => (
              <span key={i} className={`steps__seg ${i <= step ? 'steps__seg--on' : ''}`} />
            ))}
          </div>
          <div className="steps__count">{t('post.stepOf', { n: step + 1, total: STEP_COUNT })}</div>
        </div>

        {step === 0 ? (
          <div className="stack stack--wizard">
            <div className="wizard__headline">{t('post.s1.title')}</div>
            <Field label={t('post.titleLabel')} value={d.title} onChange={(v) => patch({ title: v })} placeholder={t('post.titlePlaceholder')} maxLength={80} />
            <div>
              <div className="region__title">{t('post.workTypeLabel')}</div>
              <ChipSelect single options={workOptions} value={d.workType ? [d.workType] : []} onChange={(n) => patch({ workType: n[0] ?? null })} />
            </div>
            <Field label={t('post.descLabel')} value={d.description} onChange={(v) => patch({ description: v })} placeholder={t('post.descPlaceholder')} multiline rows={5} maxLength={2000} hint={t('post.descHint')} />
          </div>
        ) : step === 1 ? (
          <div className="stack stack--wizard">
            <div className="wizard__headline">{t('post.s2.title')}</div>
            <Field label={t('post.salaryLabel')} value={d.salaryText} onChange={(v) => patch({ salaryText: v })} placeholder={t('post.salaryPlaceholder')} />
            <div>
              <div className="region__title">{t('post.feeLabel')}</div>
              <ChipSelect single options={PLACEMENT_FEES.map((f) => ({ value: f, label: t(feeKey(f)) }))} value={[d.placementFee]} onChange={(n) => patch({ placementFee: (n[0] as PlacementFee) ?? 'unknown' })} />
            </div>
            {d.placementFee === 'paid' ? (
              <Field label={t('post.feeTermsLabel')} value={d.feeTerms} onChange={(v) => patch({ feeTerms: v })} placeholder={t('post.feeTermsPlaceholder')} multiline rows={3} />
            ) : null}
          </div>
        ) : step === 2 ? (
          <div className="stack stack--wizard">
            <div className="wizard__headline">{t('post.s3.title')}</div>
            <ChipSelect options={visaOptions} value={d.visa} onChange={(v) => patch({ visa: v })} />
            <div className="hint">{t('post.visaHint')}</div>
          </div>
        ) : step === 3 ? (
          <div className="stack stack--wizard">
            <div className="wizard__headline">{t('post.cityLabel')}</div>
            <CityPicker single value={d.city ? [d.city] : []} onChange={(n) => patch({ city: n[0] ?? null })} />
            <Field label={t('post.scheduleLabel')} value={d.schedule} onChange={(v) => patch({ schedule: v })} placeholder={t('post.schedulePlaceholder')} />
          </div>
        ) : step === 4 ? (
          <div className="stack stack--wizard">
            <div className="wizard__headline">{t('post.s5.title')}</div>
            <div className="section">
              <div className="row">
                <span className="row__label">{t('filter.housing')}</span>
                <Segmented<TriState> value={d.housing} options={triOptions} onChange={(v) => patch({ housing: v })} />
              </div>
            </div>
            {d.housing === 'yes' ? (
              <Field label={t('post.housingTermsLabel')} value={d.housingTerms} onChange={(v) => patch({ housingTerms: v })} placeholder={t('post.housingTermsPlaceholder')} />
            ) : null}
            <div className="section">
              <div className="row">
                <span className="row__label">{t('filter.meals')}</span>
                <Segmented<TriState> value={d.meals} options={triOptions} onChange={(v) => patch({ meals: v })} />
              </div>
            </div>
            {d.meals === 'yes' ? (
              <Field label={t('post.mealsInfoLabel')} value={d.mealsInfo} onChange={(v) => patch({ mealsInfo: v })} placeholder={t('post.mealsInfoPlaceholder')} />
            ) : null}
          </div>
        ) : step === 5 ? (
          <div className="stack stack--wizard">
            <div className="wizard__headline">{t('post.contactLabel')}</div>
            <Field value={d.contactRaw} onChange={(v) => patch({ contactRaw: v })} placeholder={t('post.contactPlaceholder')} hint={t('post.contactHint')} />
            <div>
              <div className="region__title">{t('post.contactKindLabel')}</div>
              <ChipSelect single options={contactOptions} value={[d.contactKind]} onChange={(n) => patch({ contactKind: (n[0] as ContactKind) ?? 'other' })} />
            </div>
          </div>
        ) : (
          <div className="stack stack--wizard">
            <div className="wizard__headline">{t('post.summaryTitle')}</div>
            <div className="section">
              <SummaryRow k={t('post.titleLabel')} v={d.title || '—'} />
              <SummaryRow k={t('post.workTypeLabel')} v={d.workType ? t(workTypeKey(d.workType)) : '—'} />
              <SummaryRow k={t('post.salaryLabel')} v={d.salaryText || '—'} />
              <SummaryRow k={t('post.feeLabel')} v={t(feeKey(d.placementFee))} />
              <SummaryRow k={t('post.s3.title')} v={d.visa.length ? d.visa.map((x) => t(visaKey(x))).join(', ') : '—'} />
              <SummaryRow k={t('post.cityLabel')} v={d.city ?? '—'} />
              <SummaryRow k={t('post.contactLabel')} v={d.contactRaw || '—'} />
            </div>
            <label className="consent">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>{t('post.consent')}</span>
            </label>
          </div>
        )}

        {!isReal ? (
          <div className="wizard__nav">
            <button className="btn btn--ghost" onClick={back}>
              {step === 0 ? t('nav.back') : t('post.prev')}
            </button>
            <button className="btn btn--primary" onClick={next} disabled={!stepValid(step) || submitting}>
              {step < LAST ? t('post.next') : submitting ? t('common.saving') : t('post.publish')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function rejectText(reason: string | null, t: TFunction): string {
  switch (reason) {
    case 'too_short':
      return t('post.reject.tooShort');
    case 'no_contact':
      return t('post.reject.noContact');
    case 'policy':
      return t('post.reject.policy');
    case 'network':
      return t('post.reject.network');
    default:
      return t('post.rejectedText');
  }
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="dl">
      <span className="dl__k">{k}</span>
      <span className="dl__v">{v}</span>
    </div>
  );
}
