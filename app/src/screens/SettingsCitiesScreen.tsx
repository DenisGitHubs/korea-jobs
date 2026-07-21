import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../shared/api/client';
import { subscriptionValue, toSubscription, useSubscriptionStore } from '../store/subscriptionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useBackButton } from '../hooks/useBackButton';
import { useMainButton } from '../hooks/useMainButton';
import { AppBar } from '../components/AppBar';
import { CityPicker } from '../components/CityPicker';

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

/** Sub-screen (route /settings/cities) that edits the subscription's cities +
 *  the "city not specified" preference and persists them via POST /subscription. */
export default function SettingsCitiesScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isReal = useSettingsStore((s) => s.isReal);
  const goBack = useCallback(() => navigate('/settings'), [navigate]);
  useBackButton(true, goBack);

  const apply = useSubscriptionStore((s) => s.apply);
  const sCities = useSubscriptionStore((s) => s.citySlugs);
  const sNoCity = useSubscriptionStore((s) => s.noCity);

  const [cities, setCities] = useState<string[]>(() => sCities);
  const [noCity, setNoCity] = useState<boolean>(() => sNoCity);
  const [saving, setSaving] = useState(false);

  const dirty = !sameSet(cities, sCities) || noCity !== sNoCity;

  const save = useCallback(async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const base = subscriptionValue(useSubscriptionStore.getState());
      const saved = await api.saveSubscription(toSubscription({ ...base, citySlugs: cities, noCity }));
      apply(saved);
      navigate('/settings');
    } catch {
      /* keep local edits; the user can retry */
    } finally {
      setSaving(false);
    }
  }, [saving, dirty, cities, noCity, apply, navigate]);

  const label = saving
    ? t('common.saving')
    : cities.length
      ? t('settings.saveCitiesCount', { count: cities.length })
      : t('settings.saveCities');

  useMainButton({ text: label, visible: dirty || saving, enabled: !saving, loading: saving, onClick: save });

  return (
    <div className="app">
      <AppBar title={t('settings.citiesTitle')} onBack={goBack} />
      <div className="screen">
        <div className="hero">
          <h1 className="hero__title">{t('settings.citiesTitle')}</h1>
          <p className="hero__sub">{t('settings.citiesLead')}</p>
        </div>

        <CityPicker value={cities} onChange={setCities} noCity={noCity} onNoCityChange={setNoCity} />

        {!isReal ? (
          <button
            className="btn btn--primary btn--block"
            onClick={save}
            disabled={!dirty || saving}
            style={{ marginTop: 8, marginBottom: 22 }}
          >
            {label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
