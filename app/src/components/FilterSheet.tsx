import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VisaType, WorkType } from '../shared/types/api';
import {
  FRESHNESS_DAYS,
  VISA_TYPES,
  WORK_TYPES,
  WORK_TYPE_EMOJI,
  freshnessKey,
  visaKey,
  workTypeKey,
} from '../shared/labels';
import { EMPTY_FILTER, filterToQuery, useFilterStore, type FilterValue } from '../store/filterStore';
import { api } from '../shared/api/client';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { useMainButton } from '../hooks/useMainButton';
import { Sheet } from './Sheet';
import { Field } from './Field';
import { ChipSelect, type ChipOption } from './ChipSelect';
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
  // Live match count for the current draft; null = unknown (soft-degrade to plain label).
  const [count, setCount] = useState<number | null>(null);
  // True while a fresh count is being (re)computed for the current draft. We keep
  // the previous number visible but flag it as loading, so the button never shows
  // a confident-but-stale figure.
  const [counting, setCounting] = useState(false);

  // Seed the draft from the applied filter each time the sheet opens. Clear the
  // stale count in the SAME tick so the first frame never flashes a leftover
  // number without a spinner — the live-count effect below re-fetches it.
  useEffect(() => {
    if (open) {
      setDraft(useFilterStore.getState().value);
      setCount(null);
    }
  }, [open]);

  // Live "Show N" counter: debounced fetch on every draft change while open.
  // The previous count is kept while a new one loads (never blocks Apply), but
  // `counting` marks it as loading the instant the draft changes.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setCounting(true);
    const timer = window.setTimeout(() => {
      api
        .vacanciesCount(filterToQuery(draft))
        .then((r) => {
          if (alive) setCount(r.count);
        })
        .catch(() => {
          /* keep the previous count on error */
        })
        .finally(() => {
          if (alive) setCounting(false);
        });
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [draft, open]);

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

  // Soft-degrade to plain "Apply" until the first count arrives.
  const applyLabel = count === null ? t('filter.apply') : t('filter.showCount', { count });

  useMainButton({ text: applyLabel, visible: open, enabled: true, loading: counting, onClick: doApply });

  const workOptions = useMemo<ChipOption<WorkType>[]>(
    () => WORK_TYPES.map((w) => ({ value: w, label: t(workTypeKey(w)), emoji: WORK_TYPE_EMOJI[w] })),
    [t],
  );
  const visaOptions = useMemo<ChipOption<VisaType>[]>(
    () => VISA_TYPES.map((v) => ({ value: v, label: t(visaKey(v)) })),
    [t],
  );
  // '' = "Неважно" (no fee filter, default). ChipSelect keeps it as a single-select radio.
  const paidOptions: ChipOption<'' | 'free' | 'paid'>[] = [
    { value: '', label: t('fee.any') },
    { value: 'paid', label: t('fee.paid') },
    { value: 'free', label: t('fee.free') },
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
          <ChipSelect grid options={workOptions} value={draft.workTypes} onChange={(v) => patch({ workTypes: v })} />
        </section>

        <section className="filter__block">
          <div className="region__title">{t('filter.visa')}</div>
          <ChipSelect grid={2} options={visaOptions} value={draft.visa} onChange={(v) => patch({ visa: v })} />
          <p className="field__hint">{t('visa.disclaimer')}</p>
        </section>

        <section className="filter__block">
          <div className="region__title">{t('filter.paid')}</div>
          <ChipSelect
            single
            options={paidOptions}
            value={[draft.paid === 'free' || draft.paid === 'paid' ? draft.paid : '']}
            onChange={(next) => {
              const v = next[0];
              patch({ paid: v === 'free' || v === 'paid' ? v : null });
            }}
          />
        </section>

        <section className="filter__block">
          <div className="section">
            <div className="row">
              <div className="row__label">{t('filter.housing')}</div>
              <Switch checked={draft.housing} onChange={(v) => patch({ housing: v })} label={t('filter.housing')} />
            </div>
            <div className="row">
              <div className="row__label">{t('filter.meals')}</div>
              <Switch checked={draft.meals} onChange={(v) => patch({ meals: v })} label={t('filter.meals')} />
            </div>
          </div>
        </section>

        {!isReal ? (
          <button className="btn btn--primary btn--block" onClick={doApply} aria-busy={counting || undefined}>
            {counting ? <span className="btn__spinner" aria-hidden="true" /> : null}
            {applyLabel}
          </button>
        ) : null}
      </div>
    </Sheet>
  );
}
