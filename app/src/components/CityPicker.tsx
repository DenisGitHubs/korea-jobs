import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCities } from '../hooks/useCities';
import { useSettingsStore } from '../store/settingsStore';
import type { City } from '../shared/types/api';
import { localized } from '../lib/localized';
import { FREQUENT_CITY_SLUGS } from '../lib/cities';
import { regionKey } from '../shared/labels';
import { Loading } from './Loading';
import { IconGeoUnknown } from './icons/StateIcons';

interface CityPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Radio-style single selection (used by the ad wizard) — same province
   *  accordion as multi, but only one city can be chosen at a time. */
  single?: boolean;
  /** Tighter vertical rhythm for embedding inside the ad wizard. */
  compact?: boolean;
  /** "City not specified" toggle (filter / settings). Providing `onNoCityChange`
   *  turns on the special card + frequent chips + province accordion. */
  noCity?: boolean;
  onNoCityChange?: (b: boolean) => void;
}

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/**
 * Region-grouped city picker with a per-province accordion (single-city
 * provinces render inline without a chevron; multi-city provinces fold via
 * grid-template-rows). Shared by both modes so 167 cities never become a flat
 * wall:
 *  - `single` (ad wizard): radio selection, one city, value is `[slug]` / `[]`.
 *    No "city not specified" card (the wizard owns its own "other" option).
 *  - multi (filter / settings): checkbox selection + a "city not specified"
 *    card (via `onNoCityChange`).
 * Both show the frequent-city quick-pick chips and the expand/collapse-all head.
 */
export function CityPicker({ value, onChange, single = false, compact = false, noCity, onNoCityChange }: CityPickerProps) {
  const { t } = useTranslation();
  const lang = useSettingsStore((s) => s.lang);
  const { grouped, bySlug, loading } = useCities();

  const multiProvinces = useMemo(() => grouped.filter((g) => g.items.length > 1).map((g) => g.region), [grouped]);
  const multiSet = useMemo(() => new Set(multiProvinces), [multiProvinces]);

  // Which multi-city provinces are expanded. Seeded once (when cities first load)
  // from the incoming selection: provinces with a selected city open, rest closed.
  // Runs in both modes so the wizard opens straight to the already-picked city.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || grouped.length === 0) return;
    seeded.current = true;
    const init: Record<string, boolean> = {};
    for (const g of grouped) {
      if (g.items.length > 1) init[g.region] = g.items.some((c) => value.includes(c.slug));
    }
    setOpen(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped]);

  const toggle = (slug: string): void => {
    const isOn = value.includes(slug);
    // single: radio (one slug or none). multi: checkbox set.
    onChange(single ? (isOn ? [] : [slug]) : isOn ? value.filter((x) => x !== slug) : [...value, slug]);
    // Turning a city ON auto-expands its (collapsed) province so the row in the
    // list stays in sync with the tapped frequent chip.
    if (!isOn) {
      const region = bySlug.get(slug)?.region_slug ?? 'other';
      if (multiSet.has(region)) setOpen((o) => ({ ...o, [region]: true }));
    }
  };

  if (loading) return <Loading text={t('common.loading')} />;

  const CityRow = (c: { slug: string; name: City['name'] }) => {
    const on = value.includes(c.slug);
    return (
      <button className="row" key={c.slug} onClick={() => toggle(c.slug)} aria-pressed={on}>
        <span className="row__label">{localized(c.name, lang)}</span>
        <span className={`check ${single ? 'check--radio' : ''} ${on ? 'check--on' : ''}`} aria-hidden>
          ✓
        </span>
      </button>
    );
  };

  // ── Shared render: frequent chips + ("not specified" card in multi) + accordion. ──
  const allOpen = multiProvinces.length > 0 && multiProvinces.every((r) => open[r]);
  const toggleAll = (): void => {
    const next: Record<string, boolean> = {};
    for (const r of multiProvinces) next[r] = !allOpen;
    setOpen(next);
  };

  const frequent = FREQUENT_CITY_SLUGS.map((s) => bySlug.get(s)).filter((c): c is City => Boolean(c));

  return (
    <div className={`citypicker ${compact ? 'citypicker--compact' : ''}`}>
      {frequent.length ? (
        <div className="citypicker__frequent">
          <div className="region__title">{t('filter.frequentTitle')}</div>
          <div className="chips">
            {frequent.map((c) => {
              const on = value.includes(c.slug);
              return (
                <button
                  key={c.slug}
                  type="button"
                  className={`chip ${on ? 'chip--on' : ''}`}
                  onClick={() => toggle(c.slug)}
                  aria-pressed={on}
                >
                  {localized(c.name, lang)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {onNoCityChange ? (
        <button
          type="button"
          className="nocity"
          aria-pressed={Boolean(noCity)}
          onClick={() => onNoCityChange(!noCity)}
        >
          <span className="nocity__ico" aria-hidden>
            <IconGeoUnknown />
          </span>
          <span className="nocity__body">
            <span className="nocity__t">{t('city.unspecified')}</span>
            <span className="row__sub">{t('filter.noCityHint')}</span>
          </span>
          <span className={`check ${noCity ? 'check--on' : ''}`} aria-hidden>
            ✓
          </span>
        </button>
      ) : null}

      <div className="citypicker__head">
        <div className="region__title">{t('filter.byProvince')}</div>
        {multiProvinces.length ? (
          <button type="button" className="citypicker__toggleall" onClick={toggleAll}>
            {allOpen ? t('filter.collapseAll') : t('filter.expandAll')}
          </button>
        ) : null}
      </div>

      {grouped.map((g) => {
        const regionName = t(regionKey(g.region));
        // Single-city province (Seoul / Busan / Incheon …): no chevron, inline.
        if (g.items.length === 1) {
          return (
            <div className="region" key={g.region}>
              <div className="region__title">{regionName}</div>
              <div className="section">{CityRow(g.items[0])}</div>
            </div>
          );
        }
        const isOpen = Boolean(open[g.region]);
        const selCount = g.items.reduce((n, c) => n + (value.includes(c.slug) ? 1 : 0), 0);
        return (
          <div className={`region citypicker__prov ${isOpen ? 'is-open' : ''}`} key={g.region}>
            <button
              type="button"
              className="citypicker__prov-head"
              aria-expanded={isOpen}
              onClick={() => setOpen((o) => ({ ...o, [g.region]: !o[g.region] }))}
            >
              <span className="citypicker__prov-title">
                {regionName} <span className="citypicker__prov-num">({g.items.length})</span>
              </span>
              {selCount > 0 ? <span className="citypicker__prov-sel">{selCount}</span> : null}
              <span className="citypicker__prov-chev" aria-hidden>
                <Chevron />
              </span>
            </button>
            <div className="citypicker__prov-fold">
              <div className="citypicker__prov-fold-inner">
                <div className="section">{g.items.map((c) => CityRow(c))}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
