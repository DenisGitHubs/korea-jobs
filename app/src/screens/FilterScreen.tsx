import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../shared/api/client';
import type { WorkType } from '../shared/types/api';
import { WORK_TYPES, WORK_TYPE_EMOJI, regionKey, workTypeKey } from '../shared/labels';
import { useCities } from '../hooks/useCities';
import { useBackButton } from '../hooks/useBackButton';
import { useMainButton } from '../hooks/useMainButton';
import { useSubscriptionStore } from '../store/subscriptionStore';
import { useSettingsStore } from '../store/settingsStore';
import { localized } from '../lib/localized';
import { AppBar } from '../components/AppBar';
import { Loading } from '../components/Loading';

export default function FilterScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const lang = useSettingsStore((s) => s.lang);
  const isReal = useSettingsStore((s) => s.isReal);

  const savedCities = useSubscriptionStore((s) => s.citySlugs);
  const savedWork = useSubscriptionStore((s) => s.workTypes);
  const notify = useSubscriptionStore((s) => s.notify);
  const apply = useSubscriptionStore((s) => s.apply);
  const isEditing = savedCities.length > 0;

  const { grouped, loading } = useCities();

  const [cities, setCities] = useState<string[]>(savedCities);
  const [work, setWork] = useState<WorkType[]>(savedWork);
  const [saving, setSaving] = useState(false);

  const toggleCity = (slug: string) =>
    setCities((c) => (c.includes(slug) ? c.filter((x) => x !== slug) : [...c, slug]));
  const toggleWork = (w: WorkType) =>
    setWork((c) => (c.includes(w) ? c.filter((x) => x !== w) : [...c, w]));

  const save = useCallback(async () => {
    if (!cities.length || saving) return;
    setSaving(true);
    try {
      const s = await api.saveSubscription({ city_slugs: cities, work_types: work, notify });
      apply(s);
      navigate('/feed', { replace: true });
    } catch {
      setSaving(false);
    }
  }, [cities, work, notify, saving, apply, navigate]);

  const goBack = useCallback(() => navigate('/feed'), [navigate]);
  useBackButton(isEditing, goBack);

  const saveLabel = saving
    ? t('common.saving')
    : cities.length
      ? t('filter.saveWithCount', { count: cities.length })
      : t('filter.save');

  useMainButton({
    text: saveLabel,
    visible: true,
    enabled: cities.length > 0 && !saving,
    loading: saving,
    onClick: save,
  });

  return (
    <div className="app">
      <AppBar title={t('filter.title')} onBack={isEditing ? goBack : undefined} />
      <div className="screen">
        {!isEditing ? (
          <div className="hero">
            <h1 className="hero__title">{t('onboarding.title')}</h1>
            <p className="hero__sub">{t('onboarding.subtitle')}</p>
          </div>
        ) : null}

        {loading ? (
          <Loading text={t('common.loading')} />
        ) : (
          <>
            {grouped.map((g) => (
              <div className="region" key={g.region}>
                <div className="region__title">{t(regionKey(g.region))}</div>
                <div className="section">
                  {g.items.map((c) => {
                    const on = cities.includes(c.slug);
                    return (
                      <button
                        className="row"
                        key={c.slug}
                        onClick={() => toggleCity(c.slug)}
                        aria-pressed={on}
                      >
                        <span className="row__label">{localized(c.name, lang)}</span>
                        <span className={`check ${on ? 'check--on' : ''}`} aria-hidden>
                          ✓
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            <div className="region">
              <div className="region__title">{t('filter.workTypesSection')}</div>
              <div className="chips">
                {WORK_TYPES.map((w) => {
                  const on = work.includes(w);
                  return (
                    <button
                      key={w}
                      className={`chip ${on ? 'chip--on' : ''}`}
                      onClick={() => toggleWork(w)}
                      aria-pressed={on}
                    >
                      <span aria-hidden>{WORK_TYPE_EMOJI[w]}</span>
                      {t(workTypeKey(w))}
                    </button>
                  );
                })}
              </div>
              <div className="hint">{t('filter.workTypesHint')}</div>
            </div>
          </>
        )}
      </div>

      {!isReal ? (
        <div className="stickybar">
          <button
            className="btn btn--primary btn--block"
            disabled={!cities.length || saving}
            onClick={save}
          >
            {saveLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}
