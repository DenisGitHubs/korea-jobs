import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../shared/api/client';
import type { VisaType, WorkType } from '../shared/types/api';
import { VISA_TYPES, WORK_TYPES, visaKey, workTypeKey } from '../shared/labels';
import { WorkTypeIcon } from '../components/icons/WorkTypeIcon';
import { toSubscription, useSubscriptionStore } from '../store/subscriptionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { useCities } from '../hooks/useCities';
import { citiesSummary } from '../lib/cities';
import type { Lang } from '../i18n';
import type { ThemeMode } from '../lib/theme';
import { AppBar } from '../components/AppBar';
import { Switch } from '../components/Switch';
import { Segmented } from '../components/Segmented';
import { ChipSelect, type ChipOption } from '../components/ChipSelect';
import { Modal } from '../components/Modal';

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
  const setTourReplay = useUiStore((s) => s.setTourReplay);
  const { bySlug } = useCities();

  const apply = useSubscriptionStore((s) => s.apply);
  const sCities = useSubscriptionStore((s) => s.citySlugs);
  const sRegions = useSubscriptionStore((s) => s.regionSlugs);
  const sNoCity = useSubscriptionStore((s) => s.noCity);
  const sWork = useSubscriptionStore((s) => s.workTypes);
  const sVisa = useSubscriptionStore((s) => s.visaTypes);
  const sFee = useSubscriptionStore((s) => s.placementFee);
  const sHousing = useSubscriptionStore((s) => s.requireHousing);
  const sMeals = useSubscriptionStore((s) => s.requireMeals);
  const sNotify = useSubscriptionStore((s) => s.notify);
  const sDigest = useSubscriptionStore((s) => s.digestEnabled);

  const [work, setWork] = useState<WorkType[]>(() => sWork);
  const [visa, setVisa] = useState<VisaType[]>(() => sVisa);
  const [paid, setPaid] = useState<'free' | 'paid' | null>(() =>
    sFee === 'free' || sFee === 'paid' ? sFee : null,
  );
  const [housing, setHousing] = useState<boolean>(() => sHousing === true);
  const [meals, setMeals] = useState<boolean>(() => sMeals === true);
  const [notify, setNotify] = useState<boolean>(() => sNotify);
  const [digest, setDigest] = useState<boolean>(() => sDigest);
  const [saving, setSaving] = useState(false);
  // Info popup shown every time the user picks the 'auto' theme, explaining the
  // Korean-time schedule. Purely informational — the mode is applied instantly.
  const [autoInfo, setAutoInfo] = useState(false);

  const onThemeChange = useCallback(
    (m: ThemeMode) => {
      setThemeMode(m);
      if (m === 'auto') setAutoInfo(true);
    },
    [setThemeMode],
  );

  const dirty =
    !sameSet(work, sWork) ||
    !sameSet(visa, sVisa) ||
    paid !== (sFee === 'free' || sFee === 'paid' ? sFee : null) ||
    housing !== (sHousing === true) ||
    meals !== (sMeals === true) ||
    notify !== sNotify ||
    digest !== sDigest;

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const body = toSubscription({
        // Cities + regions + "no city" are edited on the /settings/cities
        // sub-screen; keep the saved values untouched here.
        citySlugs: sCities,
        regionSlugs: sRegions,
        noCity: sNoCity,
        workTypes: work,
        notify,
        visaTypes: visa,
        placementFee: paid,
        requireHousing: housing ? true : null,
        requireMeals: meals ? true : null,
        digestEnabled: digest,
      });
      const saved = await api.saveSubscription(body);
      apply(saved);
    } catch {
      /* keep local edits; the user can retry */
    } finally {
      setSaving(false);
    }
  }, [saving, sCities, sNoCity, work, notify, visa, paid, housing, meals, digest, apply]);

  const citiesLabel = citiesSummary(sCities, sRegions, sNoCity, bySlug, lang, t);

  const workOptions = useMemo<ChipOption<WorkType>[]>(
    () => WORK_TYPES.map((w) => ({ value: w, label: t(workTypeKey(w)), icon: <WorkTypeIcon type={w} /> })),
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
            <div className="row">
              <div className="row__label">
                <div>{t('settings.digest')}</div>
                <div className="row__sub">{t('settings.digestHint')}</div>
              </div>
              {/* INDEPENDENT of the realtime notify toggle (Цензор, gate 21.07): a user may
                  want only the once-a-day digest. The bot's ability to DM is granted by
                  allows_write_to_pm, not by the notify subscription flag. */}
              <Switch checked={digest} onChange={setDigest} label={t('settings.digest')} />
            </div>
          </div>
        </div>

        <div className="region">
          <div className="section">
            <button className="row row--nav" onClick={() => navigate('/settings/cities')}>
              <div className="row__label">
                <div>{t('settings.citiesTitle')}</div>
                <div className="row__sub row__sub--ellipsis">{citiesLabel}</div>
              </div>
              <span className="row__chevron" aria-hidden>
                ›
              </span>
            </button>
          </div>
        </div>

        <div className="region">
          <div className="region__title">{t('filter.workTypesSection')}</div>
          <ChipSelect grid options={workOptions} value={work} onChange={setWork} />
        </div>

        <div className="region">
          <div className="region__title">{t('filter.visa')}</div>
          <ChipSelect grid={2} options={visaOptions} value={visa} onChange={setVisa} />
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
            <button className="row row--nav" onClick={() => setTourReplay(true)}>
              <div className="row__label">
                <div>{t('settings.howto')}</div>
                <div className="row__sub">{t('settings.howtoHint')}</div>
              </div>
              <span className="row__chevron" aria-hidden>
                ›
              </span>
            </button>
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
            {/* Long schedule hint sits on its own full-width line UNDER the
                segmented control, so it never gets squeezed / mis-wrapped beside
                the three theme buttons. */}
            <div className="row row--stack">
              <div className="row__line">
                <div className="row__label">{t('settings.theme')}</div>
                <Segmented<ThemeMode>
                  value={themeMode}
                  options={[
                    { value: 'auto', label: t('settings.themeAuto') },
                    { value: 'light', label: t('settings.themeLight') },
                    { value: 'dark', label: t('settings.themeDark') },
                  ]}
                  onChange={onThemeChange}
                />
              </div>
              <div className="row__sub row__sub--block">{t('settings.themeHint')}</div>
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
          </div>
        </div>
      </div>

      <Modal
        open={autoInfo}
        title={t('settings.themeAutoInfo.title')}
        actions={
          <button className="btn btn--primary btn--block" onClick={() => setAutoInfo(false)}>
            {t('settings.themeAutoInfo.ok')}
          </button>
        }
      >
        <p className="modal__text">{t('settings.themeAutoInfo.body')}</p>
      </Modal>
    </div>
  );
}
