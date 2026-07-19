import { useTranslation } from 'react-i18next';
import { useCities } from '../hooks/useCities';
import { useSettingsStore } from '../store/settingsStore';
import { localized } from '../lib/localized';
import { regionKey } from '../shared/labels';
import { Loading } from './Loading';

interface CityPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Radio-style single selection (used by the ad wizard). */
  single?: boolean;
  /** Tighter vertical rhythm for embedding inside the ad wizard. */
  compact?: boolean;
}

/** Region-grouped city checklist, shared by Settings, the filter sheet and the wizard. */
export function CityPicker({ value, onChange, single = false, compact = false }: CityPickerProps) {
  const { t } = useTranslation();
  const lang = useSettingsStore((s) => s.lang);
  const { grouped, loading } = useCities();

  const toggle = (slug: string): void => {
    if (single) {
      onChange(value[0] === slug ? [] : [slug]);
      return;
    }
    onChange(value.includes(slug) ? value.filter((x) => x !== slug) : [...value, slug]);
  };

  if (loading) return <Loading text={t('common.loading')} />;

  return (
    <div className={`citypicker ${compact ? 'citypicker--compact' : ''}`}>
      {grouped.map((g) => (
        <div className="region" key={g.region}>
          <div className="region__title">{t(regionKey(g.region))}</div>
          <div className="section">
            {g.items.map((c) => {
              const on = value.includes(c.slug);
              return (
                <button className="row" key={c.slug} onClick={() => toggle(c.slug)} aria-pressed={on}>
                  <span className="row__label">{localized(c.name, lang)}</span>
                  <span className={`check ${single ? 'check--radio' : ''} ${on ? 'check--on' : ''}`} aria-hidden>
                    ✓
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
