import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api, ApiError } from '../shared/api/client';
import type { AdInput, AdMine, ContactKind, PlacementFee, VisaType, WorkType } from '../shared/types/api';
import {
  CONTACT_KINDS,
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
import { AppBar } from '../components/AppBar';
import { Field } from '../components/Field';
import { Segmented } from '../components/Segmented';
import { ChipSelect, type ChipOption } from '../components/ChipSelect';
import { CityPicker } from '../components/CityPicker';
import { EmptyState } from '../components/EmptyState';
import { MyAdsTab } from './post/MyAdsTab';

const CONSENT_KEY = 'kj:ads-consent';
const STEP_COUNT = 7;
const LAST = STEP_COUNT - 1;
const MIN_DESC = 15;
const CONTACT_RAW_MAX = 300;

/** Fees offered in the wizard — deliberately no 'unknown' (owner decision). */
const WIZARD_FEES: readonly PlacementFee[] = ['free', 'paid'];

/** Short i18n tags used when several contact methods are joined into contact_raw. */
const CONTACT_TAG_KEY: Record<ContactKind, string> = {
  phone: 'post.contactTag.phone',
  telegram: 'post.contactTag.telegram',
  kakao: 'post.contactTag.kakao',
  whatsapp: 'post.contactTag.whatsapp',
  other: 'post.contactTag.other',
};

type TriState = 'yes' | 'no' | 'unknown';
type Tab = 'compose' | 'mine';

interface Draft {
  title: string;
  workType: WorkType | null;
  description: string;
  salaryText: string;
  placementFee: PlacementFee | null;
  feeTerms: string;
  visa: VisaType[];
  city: string | null;
  cityOther: boolean;
  cityText: string;
  schedule: string;
  housing: TriState;
  housingTerms: string;
  meals: TriState;
  mealsInfo: string;
  contactSel: ContactKind[];
  phoneVal: string;
  kakaoVal: string;
  whatsappVal: string;
  otherVal: string;
}

const triToBool = (v: TriState): boolean | null => (v === 'yes' ? true : v === 'no' ? false : null);
const boolToTri = (b: boolean | null): TriState => (b === true ? 'yes' : b === false ? 'no' : 'unknown');

/** Trimmed value entered for a given contact method (Telegram uses the @username). */
function contactValue(d: Draft, k: ContactKind, username: string): string {
  if (k === 'telegram') return username ? `@${username}` : '';
  if (k === 'phone') return d.phoneVal.trim();
  if (k === 'kakao') return d.kakaoVal.trim();
  if (k === 'whatsapp') return d.whatsappVal.trim();
  return d.otherVal.trim(); // 'other'
}

/** Join the selected methods into one labelled string, e.g. "Тел.: X · TG: @nick". */
function buildContactRaw(d: Draft, username: string, t: TFunction): string {
  const parts: string[] = [];
  for (const k of CONTACT_KINDS) {
    if (!d.contactSel.includes(k)) continue;
    const v = contactValue(d, k, username);
    if (!v) continue;
    parts.push(`${t(CONTACT_TAG_KEY[k])}: ${v}`);
  }
  return parts.join(' · ');
}

/** Contact step is valid with >=1 method, each (bar Telegram) filled, within 300 chars. */
function contactStepValid(d: Draft, username: string, t: TFunction): boolean {
  if (d.contactSel.length === 0) return false;
  for (const k of d.contactSel) {
    if (k === 'telegram') {
      if (!username) return false;
      continue;
    }
    if (!contactValue(d, k, username)) return false;
  }
  const raw = buildContactRaw(d, username, t);
  return raw.length > 0 && raw.length <= CONTACT_RAW_MAX;
}

function loadConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
}

function emptyDraft(username: string): Draft {
  return {
    title: '',
    workType: null,
    description: '',
    salaryText: '',
    placementFee: null,
    feeTerms: '',
    visa: [],
    city: null,
    cityOther: false,
    cityText: '',
    schedule: '',
    housing: 'unknown',
    housingTerms: '',
    meals: 'unknown',
    mealsInfo: '',
    // Telegram is the default when the user has a public @username.
    contactSel: username ? ['telegram'] : [],
    phoneVal: '',
    kakaoVal: '',
    whatsappVal: '',
    otherVal: '',
  };
}

/** Rebuild a wizard Draft from an existing ad (edit mode). Contact is handled
 *  separately as a single free-text field so the original string round-trips. */
function draftFromAd(ad: AdMine): Draft {
  const fee: PlacementFee | null =
    ad.placement_fee === 'paid' ? 'paid' : ad.placement_fee === 'free' ? 'free' : null;
  return {
    title: ad.title,
    workType: ad.work_type,
    description: ad.description,
    salaryText: ad.salary_text ?? '',
    placementFee: fee,
    feeTerms: '',
    visa: ad.visa_types ?? [],
    city: ad.city ? ad.city.slug : null,
    cityOther: !ad.city && !!ad.city_text,
    cityText: ad.city_text ?? '',
    schedule: ad.schedule ?? '',
    housing: boolToTri(ad.has_housing),
    housingTerms: ad.housing_terms ?? '',
    meals: boolToTri(ad.has_meals),
    mealsInfo: ad.meals_info ?? '',
    contactSel: [],
    phoneVal: '',
    kakaoVal: '',
    whatsappVal: '',
    otherVal: '',
  };
}

export default function PostScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const username = useSettingsStore((s) => s.username);

  const [tab, setTab] = useState<Tab>('compose');
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<'form' | 'result'>('form');
  const [result, setResult] = useState<'approved' | 'pending' | 'rejected' | null>(null);
  const [rejectReason, setRejectReason] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [consent, setConsent] = useState<boolean>(loadConsent);

  // Edit mode: when set, the wizard PATCHes this ad instead of creating one.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContact, setEditContact] = useState('');
  const [editContactKind, setEditContactKind] = useState<ContactKind>('other');
  const [lastWasEdit, setLastWasEdit] = useState(false);

  const [d, setD] = useState<Draft>(() => emptyDraft(username));
  const patch = useCallback((p: Partial<Draft>) => setD((prev) => ({ ...prev, ...p })), []);

  // Live join of the selected contact methods — drives the summary + counter.
  const contactJoined = buildContactRaw(d, username, t);
  const editContactLen = editContact.trim().length;
  const salaryHasDigit = /\d/.test(d.salaryText);

  const stepValid = (s: number): boolean => {
    switch (s) {
      case 0:
        return d.title.trim().length > 0 && d.description.trim().length >= MIN_DESC;
      case 1:
        // At least one digit in the salary, and a fee choice (free/paid) is made.
        return salaryHasDigit && d.placementFee !== null;
      case 3:
        // City is optional, but "Other" requires a typed city name.
        return d.cityOther ? d.cityText.trim().length > 0 : true;
      case 5:
        return editingId
          ? editContactLen > 0 && editContactLen <= CONTACT_RAW_MAX
          : contactStepValid(d, username, t);
      case 6:
        return consent;
      default:
        return true;
    }
  };

  const buildInput = (): AdInput => {
    const salary = [
      d.salaryText.trim(),
      d.placementFee === 'paid' && d.feeTerms.trim() ? `${t('post.feeTermsShort')}: ${d.feeTerms.trim()}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      title: d.title.trim(),
      description: d.description.trim(),
      contact_raw: editingId ? editContact.trim() : buildContactRaw(d, username, t),
      contact_kind: editingId ? editContactKind : d.contactSel[0] ?? 'other',
      work_type: d.workType ?? undefined,
      visa_types: d.visa.length ? d.visa : undefined,
      placement_fee: d.placementFee ?? undefined,
      has_housing: triToBool(d.housing),
      has_meals: triToBool(d.meals),
      salary_text: salary || null,
      housing_terms: d.housing === 'yes' && d.housingTerms.trim() ? d.housingTerms.trim() : null,
      meals_info: d.meals === 'yes' && d.mealsInfo.trim() ? d.mealsInfo.trim() : null,
      schedule: d.schedule.trim() || null,
      city_slug: d.cityOther ? null : d.city,
      city_text: d.cityOther && d.cityText.trim() ? d.cityText.trim() : null,
      region_slug: null,
    };
  };

  const publish = useCallback(() => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      localStorage.setItem(CONSENT_KEY, '1');
    } catch {
      /* storage blocked */
    }
    const input = buildInput();
    const editing = editingId;
    const req = editing ? api.adPatch(editing, input) : api.createAd(input);
    req
      .then((r) => {
        setResult(r.status);
        setRejectReason(null);
        setLastWasEdit(Boolean(editing));
        setPhase('result');
      })
      .catch((e) => {
        if (editing) {
          // Edit: keep the wizard open and surface the error inline (incl. the
          // anti-hammer 429 cooldown), so the draft is never lost.
          setSubmitError(
            e instanceof ApiError && e.http === 429 ? t('myAds.editCooldown') : t('post.reject.network'),
          );
        } else {
          setResult('rejected');
          setRejectReason('network');
          setPhase('result');
        }
      })
      .finally(() => setSubmitting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting, d, consent, t, username, editingId, editContact, editContactKind]);

  const next = useCallback(() => {
    if (!stepValid(step)) return;
    if (step < LAST) setStep((s) => s + 1);
    else publish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, publish]);

  /** Leave edit mode and reset the wizard back to an empty compose draft. */
  const resetWizard = useCallback(() => {
    setEditingId(null);
    setEditContact('');
    setEditContactKind('other');
    setSubmitError(null);
    setD(emptyDraft(username));
    setStep(0);
    setPhase('form');
  }, [username]);

  const back = useCallback(() => {
    if (phase === 'result') {
      if (lastWasEdit) {
        resetWizard();
        setLastWasEdit(false);
        setTab('mine');
      } else {
        navigate('/feed');
      }
      return;
    }
    if (tab === 'mine') {
      navigate('/feed');
      return;
    }
    if (step > 0) {
      setStep((s) => s - 1);
      return;
    }
    // Step 0: cancel an edit back to the list, otherwise leave the screen.
    if (editingId) {
      resetWizard();
      setTab('mine');
    } else {
      navigate('/feed');
    }
  }, [phase, tab, step, editingId, lastWasEdit, navigate, resetWizard]);

  useBackButton(true, back);

  /** Enter edit mode for an ad picked from the "My ads" list. */
  const startEdit = useCallback(
    (ad: AdMine) => {
      setD(draftFromAd(ad));
      setEditContact(ad.contact_raw ?? '');
      setEditContactKind(ad.contact_kind ?? 'other');
      setEditingId(ad.id);
      setConsent(true);
      setStep(0);
      setPhase('form');
      setSubmitError(null);
      setTab('compose');
    },
    [],
  );

  const toggleContact = useCallback((k: ContactKind) => {
    setD((prev) => ({
      ...prev,
      contactSel: prev.contactSel.includes(k)
        ? prev.contactSel.filter((x) => x !== k)
        : [...prev.contactSel, k],
    }));
  }, []);

  const workOptions = useMemo<ChipOption<WorkType>[]>(
    () => WORK_TYPES.map((w) => ({ value: w, label: t(workTypeKey(w)), emoji: WORK_TYPE_EMOJI[w] })),
    [t],
  );
  // 'any' ("Неважно") is intentionally added here only — hidden elsewhere.
  const visaOptions = useMemo<ChipOption<VisaType>[]>(
    () => [
      { value: 'any' as VisaType, label: t('visa.any') },
      ...VISA_TYPES.map((v) => ({ value: v, label: t(visaKey(v)) })),
    ],
    [t],
  );
  // Selecting 'any' clears the rest; selecting a concrete visa clears 'any'.
  const onVisaChange = (nextVisa: VisaType[]): void => {
    const added = nextVisa.find((x) => !d.visa.includes(x));
    if (added === 'any') {
      patch({ visa: ['any'] });
    } else if (added) {
      patch({ visa: nextVisa.filter((x) => x !== 'any') });
    } else {
      patch({ visa: nextVisa });
    }
  };
  const triOptions = useMemo(
    () => [
      { value: 'yes' as TriState, label: t('common.yes') },
      { value: 'no' as TriState, label: t('common.no') },
      { value: 'unknown' as TriState, label: t('vacancy.notStated') },
    ],
    [t],
  );

  const tabOptions = useMemo(
    () => [
      { value: 'compose' as Tab, label: t('myAds.tabCompose') },
      { value: 'mine' as Tab, label: t('myAds.tabMine') },
    ],
    [t],
  );

  if (phase === 'result') {
    const toList = (): void => {
      resetWizard();
      setLastWasEdit(false);
      setTab('mine');
    };
    const editAction = lastWasEdit
      ? { label: t('myAds.toMine'), onAction: toList }
      : { label: t('post.toFeed'), onAction: () => navigate('/feed') };
    return (
      <div className="app">
        <AppBar title={t('post.title')} onBack={editAction.onAction} />
        <div className="screen">
          {result === 'approved' ? (
            <EmptyState
              emoji="✅"
              title={t('post.approvedTitle')}
              subtitle={t('post.approvedText')}
              actionLabel={editAction.label}
              onAction={editAction.onAction}
            />
          ) : result === 'pending' ? (
            <EmptyState
              emoji="🕓"
              title={t('post.pendingTitle')}
              subtitle={lastWasEdit ? t('myAds.editReviewText') : t('post.pendingText')}
              actionLabel={editAction.label}
              onAction={editAction.onAction}
            />
          ) : (
            <EmptyState
              emoji="⚠️"
              title={t('post.rejectedTitle')}
              subtitle={rejectText(rejectReason, t)}
              actionLabel={lastWasEdit ? t('myAds.toMine') : t('post.edit')}
              onAction={lastWasEdit ? toList : () => setPhase('form')}
            />
          )}
        </div>
      </div>
    );
  }

  const showTabs = !editingId;

  return (
    <div className="app">
      <AppBar title={t('post.title')} onBack={back} />
      <div className="screen">
        {showTabs ? (
          <Segmented<Tab>
            className="segmented--tabs"
            value={tab}
            options={tabOptions}
            onChange={setTab}
          />
        ) : null}

        {tab === 'mine' ? (
          <MyAdsTab onEdit={startEdit} onGoCompose={() => setTab('compose')} />
        ) : (
          <>
            {editingId ? <div className="hero__note">{t('myAds.editNote')}</div> : null}

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
                <div className="wizard__headline">{editingId ? t('myAds.editTitle') : t('post.s1.title')}</div>
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
                <Field
                  label={t('post.salaryLabel')}
                  value={d.salaryText}
                  onChange={(v) => patch({ salaryText: v })}
                  placeholder={t('post.salaryPlaceholder')}
                  hint={salaryHasDigit ? undefined : t('post.salaryDigitsHint')}
                />
                <div>
                  <div className="region__title">{t('post.feeLabel')}</div>
                  <ChipSelect single options={WIZARD_FEES.map((f) => ({ value: f, label: t(feeKey(f)) }))} value={d.placementFee ? [d.placementFee] : []} onChange={(n) => patch({ placementFee: (n[0] as PlacementFee) ?? null })} />
                </div>
                {d.placementFee === 'paid' ? (
                  <Field label={t('post.feeTermsLabel')} value={d.feeTerms} onChange={(v) => patch({ feeTerms: v })} placeholder={t('post.feeTermsPlaceholder')} multiline rows={3} />
                ) : null}
              </div>
            ) : step === 2 ? (
              <div className="stack stack--wizard">
                <div className="wizard__headline">{t('post.s3.title')}</div>
                <ChipSelect options={visaOptions} value={d.visa} onChange={onVisaChange} />
                <div className="hint">{t('post.visaHint')}</div>
              </div>
            ) : step === 3 ? (
              <div className="stack stack--wizard">
                <div className="wizard__headline">{t('post.cityLabel')}</div>
                <CityPicker compact single value={d.city ? [d.city] : []} onChange={(n) => patch({ city: n[0] ?? null, cityOther: false })} />
                <div className="section">
                  <button
                    type="button"
                    className="row"
                    onClick={() => patch({ cityOther: true, city: null })}
                    aria-pressed={d.cityOther}
                  >
                    <span className="row__label">{t('post.cityOtherOption')}</span>
                    <span className={`check check--radio ${d.cityOther ? 'check--on' : ''}`} aria-hidden>
                      ✓
                    </span>
                  </button>
                </div>
                {d.cityOther ? (
                  <Field label={t('post.cityOtherLabel')} value={d.cityText} onChange={(v) => patch({ cityText: v })} placeholder={t('post.cityOtherPlaceholder')} maxLength={60} />
                ) : null}
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
              editingId ? (
                <div className="stack stack--wizard">
                  <div className="wizard__headline">{t('post.contactLabel')}</div>
                  <Field
                    label={t('post.contactLabel')}
                    value={editContact}
                    onChange={setEditContact}
                    placeholder={t('post.contactPlaceholder')}
                    multiline
                    rows={2}
                    maxLength={CONTACT_RAW_MAX}
                    hint={t('myAds.editContactHint')}
                  />
                  <div className={`hint ${editContactLen > CONTACT_RAW_MAX ? 'hint--warn' : ''}`}>
                    {t('post.contactLenHint', { n: editContactLen })}
                  </div>
                </div>
              ) : (
                <div className="stack stack--wizard">
                  <div className="wizard__headline">{t('post.contactLabel')}</div>
                  <div>
                    <div className="region__title">{t('post.contactKindLabel')}</div>
                    <div className="chips">
                      {CONTACT_KINDS.map((k) => {
                        const on = d.contactSel.includes(k);
                        const tgDisabled = k === 'telegram' && !username;
                        return (
                          <button
                            key={k}
                            type="button"
                            className={`chip ${on ? 'chip--on' : ''}`}
                            onClick={() => toggleContact(k)}
                            aria-pressed={on}
                            disabled={tgDisabled}
                          >
                            {t(contactKindKey(k))}
                          </button>
                        );
                      })}
                    </div>
                    <div className="hint">{username ? t('post.contactPickHint') : t('post.contactTgNoNick')}</div>
                  </div>

                  {d.contactSel.includes('phone') ? (
                    <Field label={t('post.contactPhoneLabel')} value={d.phoneVal} onChange={(v) => patch({ phoneVal: v })} placeholder={t('post.contactPhonePlaceholder')} type="tel" inputMode="tel" maxLength={60} />
                  ) : null}

                  {d.contactSel.includes('telegram') && username ? (
                    <label className="field">
                      <span className="field__label">{t('contactKind.telegram')}</span>
                      <div className="field__input field__input--readonly">@{username}</div>
                      <span className="field__hint">{t('post.contactTgAutofill')}</span>
                    </label>
                  ) : null}

                  {d.contactSel.includes('kakao') ? (
                    <Field label={t('post.contactKakaoLabel')} value={d.kakaoVal} onChange={(v) => patch({ kakaoVal: v })} placeholder={t('post.contactKakaoPlaceholder')} maxLength={60} />
                  ) : null}

                  {d.contactSel.includes('whatsapp') ? (
                    <Field label={t('post.contactWhatsappLabel')} value={d.whatsappVal} onChange={(v) => patch({ whatsappVal: v })} placeholder={t('post.contactWhatsappPlaceholder')} type="tel" inputMode="tel" maxLength={60} />
                  ) : null}

                  {d.contactSel.includes('other') ? (
                    <Field label={t('post.contactOtherLabel')} value={d.otherVal} onChange={(v) => patch({ otherVal: v })} placeholder={t('post.contactOtherPlaceholder')} maxLength={80} />
                  ) : null}

                  {d.contactSel.length ? (
                    <div className={`hint ${contactJoined.length > CONTACT_RAW_MAX ? 'hint--warn' : ''}`}>
                      {t('post.contactLenHint', { n: contactJoined.length })}
                    </div>
                  ) : null}
                </div>
              )
            ) : (
              <div className="stack stack--wizard">
                <div className="wizard__headline">{t('post.summaryTitle')}</div>
                <div className="section">
                  <SummaryRow k={t('post.titleLabel')} v={d.title || '—'} />
                  <SummaryRow k={t('post.workTypeLabel')} v={d.workType ? t(workTypeKey(d.workType)) : '—'} />
                  <SummaryRow k={t('post.salaryLabel')} v={d.salaryText || '—'} />
                  <SummaryRow k={t('post.feeLabel')} v={d.placementFee ? t(feeKey(d.placementFee)) : '—'} />
                  <SummaryRow k={t('post.s3.title')} v={d.visa.length ? d.visa.map((x) => t(visaKey(x))).join(', ') : '—'} />
                  <SummaryRow k={t('post.cityLabel')} v={d.cityOther ? d.cityText.trim() || '—' : d.city ?? '—'} />
                  <SummaryRow k={t('post.contactLabel')} v={(editingId ? editContact : contactJoined) || '—'} />
                </div>
                {editingId ? (
                  <div className="hero__note">{t('myAds.editNote')}</div>
                ) : (
                  <label className="consent">
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                    <span>{t('post.consent')}</span>
                  </label>
                )}
              </div>
            )}

            {submitError ? (
              <div className="hint hint--warn" role="alert">
                {submitError}
              </div>
            ) : null}

            {/* In-app wizard nav is the primary CTA on this screen. We drive it in the
                DOM (brand-orange) instead of the native Telegram MainButton so the
                action is on-brand and the bottom TabBar can stay visible. */}
            <div className="wizard__nav">
              <button className="btn btn--ghost" onClick={back}>
                {step === 0 ? t('nav.back') : t('post.prev')}
              </button>
              <button className="btn btn--primary" onClick={next} disabled={!stepValid(step) || submitting}>
                {step < LAST
                  ? t('post.next')
                  : submitting
                    ? t('common.saving')
                    : editingId
                      ? t('myAds.saveEdit')
                      : t('post.publish')}
              </button>
            </div>
          </>
        )}
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
