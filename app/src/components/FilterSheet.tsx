import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlacementFee, VisaType, WorkType } from '../shared/types/api';
import { FRESHNESS_DAYS, VISA_TYPES, WORK_TYPES, WORK_TYPE_EMOJI, freshnessKey, visaKey, workTypeKey } from '../shared/labels';
import { EMPTY_FILTER, useFilterStore, type FilterValue } from '../store/filterStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { useMainButton } from '../hooks/useMainButton';
import { Sheet } from './Sheet';
import { Field } from './Field';
import { ChipSelect, type ChipOption } from './ChipSelect';
import { CityPicker } from './CityPicker';
import { Switch } from './Switch';

interface FilterSheetProps {
  open: boolean;
  onClose: () => void;
}

/** Temporary feed filter, presented as a bottom sheet over the feed. */
export function FilterSheet({ open, onClose }: FilterSheetProps) {
  const { t } = useTranslation();
  const apply = useFilterStore((s) => s.apply);
  const isReal = useSettingsStore((s) => s.isReal);
  const setTabBarHidden = useUiStore((s) => s.setTabBarHidden);

  const [draft, setDraft] = useState<FilterValue>(EMPTY_FILTER);

  // Seed the draft from the applied filter each time the sheet opens.
  useEffect(() => {
    if (open) setDraft(useFilterStore.getState().value);
  }, [open]);

  // Hide the TabBar while the sheet (with its Apply MainButton) is open.
  useEffect(() => {
    setTabBarHidden(open);
    return () => setTabBarHidden(false);
  }, [open, setTabBarHidden]);

  const patch = useCallback((p: Partial<FilterValue>) => setDraft((d) => ({ ...d, ...p })), []);

  const doApply = useCallback(() => {
    apply(draft);
    onClose();
  }, [apply, draft, onClose]);

  useMainButton({ text: t('filter.apply'), visible: open, enabled: true, onClick: doApply });

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
  const freshnessOptions: ChipOption<string>[] = [
    { value: '', label: t('freshness.any') },
    ...FRESHNESS_DAYS.map((d) => ({ value: String(d), label: t(freshnessKey(d)) })),
  ];

  const reset = (
    <button className="sheet__reset" onClick={() => setDraft(EMPTY_FILTER)}>
      {t('common.clear')}
    </button>
  );

  return (
    <Sheet open={open} onClose={onClose} title={t('filter.title')} headerAction={reset}>
      <div className="filter">
        <section className="filter__block">
          <div className="region__title">{t('filter.keywords')}</div>
          <Field
            value={draft.keywords}
            onChange={(v) => patch({ keywords: v })}
            placeholder={t('filter.keywordsPlaceholder')}
            hint={t('filter.keywordsHint')}
          />
        </section>

        <section className="filter__block">
          <div className="region__title">{t('filter.freshness')}</div>
          <ChipSelect
            single
            options={freshnessOptions}
            value={draft.freshness === null ? [''] : [String(draft.freshness)]}
            onChange={(next) => {
              const v = next[0];
              patch({ freshness: v ? (Number(v) as 1 | 3 | 7 | 14) : null });
            }}
          />
        </section>

        <section className="filter__block">
          <div className="region__title">{t('filter.workTypesSection')}</div>
          <ChipSelect options={workOptions} value={draft.workTypes} onChange={(v) => patch({ workTypes: v })} />
        </section>

        <section className="filter__block">
          <div className="region__title">{t('filter.visa')}</div>
          <ChipSelect options={visaOptions} value={draft.visa} onChange={(v) => patch({ visa: v })} />
          <div className="hint">{t('filter.rareHint')}</div>
        </section>

        <section className="filter__block">
          <div className="region__title">{t('filter.paid')}</div>
          <ChipSelect
            single
            options={paidOptions}
            value={draft.paid === 'free' || draft.paid === 'paid' ? [draft.paid] : []}
            onChange={(next) => patch({ paid: (next[0] as PlacementFee) ?? null })}
          />
          <div className="hint">{t('filter.rareHint')}</div>
        </section>

        <section className="filter__block">
          <div className="section">
            <div className="row">
              <div className="row__label">
                <div>{t('filter.housing')}</div>
                <div className="row__sub">{t('filter.rareHint')}</div>
              </div>
              <Switch checked={draft.housing} onChange={(v) => patch({ housing: v })} label={t('filter.housing')} />
            </div>
            <div className="row">
              <div className="row__label">
                <div>{t('filter.meals')}</div>
                <div className="row__sub">{t('filter.rareHint')}</div>
              </div>
              <Switch checked={draft.meals} onChange={(v) => patch({ meals: v })} label={t('filter.meals')} />
            </div>
          </div>
        </section>

        <section className="filter__block">
          <div className="region__title">{t('filter.citiesSection')}</div>
          <CityPicker value={draft.cities} onChange={(v) => patch({ cities: v })} />
        </section>

        {!isReal ? (
          <button className="btn btn--primary btn--block" onClick={doApply}>
            {t('filter.apply')}
          </button>
        ) : null}
      </div>
    </Sheet>
  );
}
