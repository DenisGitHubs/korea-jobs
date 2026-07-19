import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../shared/api/client';
import type { VisaType, WorkType } from '../shared/types/api';
import { VISA_TYPES, WORK_TYPES, WORK_TYPE_EMOJI, visaKey, workTypeKey } from '../shared/labels';
import { toSubscription, useSubscriptionStore } from '../store/subscriptionStore';
import { useSettingsStore } from '../store/settingsStore';
import type { Lang } from '../i18n';
import type { ThemeMode } from '../lib/theme';
import { AppBar } from '../components/AppBar';
import { Switch } from '../components/Switch';
import { Segmented } from '../components/Segmented';
import { ChipSelect, type ChipOption } from '../components/ChipSelect';

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

export default function SettingsScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const lang = useSettingsStore((s) => s.lang);
  const setLang = useSettingsStore((s) => s.setLang);
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);

  const apply = useSubscriptionStore((s) => s.apply);
  const sCities = useSubscriptionStore((s) => s.citySlugs);
  const sWork = useSubscriptionStore((s) => s.workTypes);
  const sVisa = useSubscriptionStore((s) => s.visaTypes);
  const sFee = useSubscriptionStore((s) => s.placementFee);
  const sHousing = useSubscriptionStore((s) => s.requireHousing);
  const sMeals = useSubscriptionStore((s) => s.requireMeals);
  const sNotify = useSubscriptionStore((s) => s.notify);

  const [work, setWork] = useState<WorkType[]>(() => sWork);
  const [visa, setVisa] = useState<VisaType[]>(() => sVisa);
  const [paid, setPaid] = useState<'free' | 'paid' | null>(() =>
    sFee === 'free' || sFee === 'paid' ? sFee : null,
  );
  const [housing, setHousing] = useState<boolean>(() => sHousing === true);
  const [meals, setMeals] = useState<boolean>(() => sMeals === true);
  const [notify, setNotify] = useState<boolean>(() => sNotify);
  const [saving, setSaving] = useState(false);

  const dirty =
    !sameSet(work, sWork) ||
    !sameSet(visa, sVisa) ||
    paid !== (sFee === 'free' || sFee === 'paid' ? sFee : null) ||
    housing !== (sHousing === true) ||
    meals !== (sMeals === true) ||
    notify !== sNotify;

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const body = toSubscription({
        // City selection is temporarily hidden; keep the saved cities untouched.
        citySlugs: sCities,
        workTypes: work,
        notify,
        visaTypes: visa,
        placementFee: paid,
        requireHousing: housing ? true : null,
        requireMeals: meals ? true : null,
      });
      const saved = await api.saveSubscription(body);
      apply(saved);
    } catch {
      /* keep local edits; the user can retry */
    } finally {
      setSaving(false);
    }
  }, [saving, sCities, work, notify, visa, paid, housing, meals, apply]);

  const workOptions = useMemo<ChipOption<WorkType>[]>(
    () => WORK_TYPES.map((w) => ({ value: w, label: t(workTypeKey(w)), emoji: WORK_TYPE_EMOJI[w] })),
    [t],
  );
  const visaOptions = useMemo<ChipOption<VisaType>[]>(
    () => VISA_TYPES.map((v) => ({ value: v, label: t(visaKey(v)) })),
    [t],
  );
  const paidOptions: ChipOption<'free' | 'paid'>[] = [
    { value: 'free', label: t('fee.free') },
    { value: 'paid', label: t('fee.paid') },
  ];

  return (
    <div className="app">
      <AppBar title={t('settings.title')} />
      <div className="screen">
        <div className="hero">
          <h1 className="hero__title">{t('settings.subscriptionTitle')}</h1>
          <p className="hero__sub">{t('settings.subscriptionHint')}</p>
        </div>

        <div className="region">
          <div className="section">
            <div className="row">
              <div className="row__label">
                <div>{t('settings.notifications')}</div>
                <div className="row__sub">{t('settings.notificationsHint')}</div>
              </div>
              <Switch checked={notify} onChange={setNotify} label={t('settings.notifications')} />
            </div>
          </div>
        </div>

        <div className="region">
          <div className="region__title">{t('filter.workTypesSection')}</div>
          <ChipSelect grid options={workOptions} value={work} onChange={setWork} />
        </div>

        <div className="region">
          <div className="region__title">{t('filter.visa')}</div>
          <ChipSelect options={visaOptions} value={visa} onChange={setVisa} />
        </div>

        <div className="region">
          <div className="region__title">{t('filter.paid')}</div>
          <ChipSelect
            single
            options={paidOptions}
            value={paid ? [paid] : []}
            onChange={(next) => setPaid((next[0] as 'free' | 'paid') ?? null)}
          />
        </div>

        <div className="region">
          <div className="section">
            <div className="row">
              <div className="row__label">{t('filter.housing')}</div>
              <Switch checked={housing} onChange={setHousing} label={t('filter.housing')} />
            </div>
            <div className="row">
              <div className="row__label">{t('filter.meals')}</div>
              <Switch checked={meals} onChange={setMeals} label={t('filter.meals')} />
            </div>
          </div>
        </div>

        <button
          className="btn btn--primary btn--block"
          onClick={save}
          disabled={!dirty || saving}
          style={{ marginBottom: 22 }}
        >
          {saving ? t('common.saving') : dirty ? t('settings.saveSubscription') : t('settings.saved')}
        </button>

        <div className="region">
          <div className="section">
            <button className="row row--nav" onClick={() => navigate('/referral')}>
              <div className="row__label">
                <div>{t('settings.inviteFriends')}</div>
                <div className="row__sub">{t('settings.inviteFriendsHint')}</div>
              </div>
              <span className="row__chevron" aria-hidden>
                ›
              </span>
            </button>
            <button className="row row--nav" onClick={() => navigate('/safety')}>
              <div className="row__label">
                <div>{t('settings.safety')}</div>
                <div className="row__sub">{t('settings.safetyHint')}</div>
              </div>
              <span className="row__chevron" aria-hidden>
                ›
              </span>
            </button>
            <button className="row row--nav" onClick={() => navigate('/rules')}>
              <div className="row__label">
                <div>{t('settings.rules')}</div>
                <div className="row__sub">{t('settings.rulesHint')}</div>
              </div>
              <span className="row__chevron" aria-hidden>
                ›
              </span>
            </button>
            <button className="row row--nav" onClick={() => navigate('/privacy')}>
              <div className="row__label">
                <div>{t('settings.privacy')}</div>
                <div className="row__sub">{t('settings.privacyHint')}</div>
              </div>
              <span className="row__chevron" aria-hidden>
                ›
              </span>
            </button>
          </div>
        </div>

        <div className="region">
          <div className="region__title">{t('settings.appearance')}</div>
          <div className="section">
            <div className="row">
              <span className="row__label">{t('settings.theme')}</span>
              <Segmented<ThemeMode>
                value={themeMode}
                options={[
                  { value: 'auto', label: t('settings.themeAuto') },
                  { value: 'light', label: t('settings.themeLight') },
                  { value: 'dark', label: t('settings.themeDark') },
                ]}
                onChange={setThemeMode}
              />
            </div>
            <div className="row">
              <span className="row__label">{t('settings.language')}</span>
              <Segmented<Lang>
                value={lang}
                options={[
                  { value: 'ru', label: 'RU' },
                  { value: 'en', label: 'EN' },
                ]}
                onChange={setLang}
              />
            </div>
          </div>
        </div>

        <div className="region">
          <div className="region__title">{t('settings.aboutTitle')}</div>
          <div className="section">
            <div className="dl">
              <span className="dl__v">{t('settings.aboutText')}</span>
            </div>
            <div className="dl">
              <span className="dl__k">{t('settings.version')}</span>
              <span className="dl__v">0.2.0 · mock</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
