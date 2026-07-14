import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../shared/api/client';
import { useCities } from '../hooks/useCities';
import { useBackButton } from '../hooks/useBackButton';
import { useSubscriptionStore } from '../store/subscriptionStore';
import { useSettingsStore } from '../store/settingsStore';
import type { Lang } from '../i18n';
import { localized } from '../lib/localized';
import { AppBar } from '../components/AppBar';
import { Switch } from '../components/Switch';
import { Segmented } from '../components/Segmented';

export default function SettingsScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const lang = useSettingsStore((s) => s.lang);
  const setLang = useSettingsStore((s) => s.setLang);

  const citySlugs = useSubscriptionStore((s) => s.citySlugs);
  const workTypes = useSubscriptionStore((s) => s.workTypes);
  const notify = useSubscriptionStore((s) => s.notify);
  const setNotify = useSubscriptionStore((s) => s.setNotify);

  const { bySlug } = useCities();

  const goBack = useCallback(() => navigate('/feed'), [navigate]);
  useBackButton(true, goBack);

  const onNotify = useCallback(
    (v: boolean) => {
      setNotify(v); // optimistic
      api
        .saveSubscription({ city_slugs: citySlugs, work_types: workTypes, notify: v })
        .catch(() => setNotify(!v));
    },
    [citySlugs, workTypes, setNotify],
  );

  const cityNames = citySlugs.map((slug) => {
    const c = bySlug.get(slug);
    return c ? localized(c.name, lang) : slug;
  });

  return (
    <div className="app">
      <AppBar title={t('settings.title')} onBack={goBack} />
      <div className="screen">
        <div className="region">
          <div className="section">
            <div className="row">
              <div className="row__label">
                <div>{t('settings.notifications')}</div>
                <div className="row__sub">{t('settings.notificationsHint')}</div>
              </div>
              <Switch checked={notify} onChange={onNotify} label={t('settings.notifications')} />
            </div>
          </div>
        </div>

        <div className="region">
          <div className="region__title">{t('settings.language')}</div>
          <div className="section">
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
          <div className="region__title">{t('settings.citiesTitle')}</div>
          <div className="section">
            <div className="row">
              <div className="row__label">
                <div>
                  {citySlugs.length
                    ? t('settings.citiesCount', { count: citySlugs.length })
                    : t('settings.noCities')}
                </div>
                {cityNames.length ? <div className="row__sub">{cityNames.join(', ')}</div> : null}
              </div>
              <button className="appbar__btn" onClick={() => navigate('/filter')}>
                {t('settings.editCities')}
              </button>
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
              <span className="dl__v">0.1.0 · mock</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
