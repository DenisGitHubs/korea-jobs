export interface ChipOption<T extends string> {
  value: T;
  label: string;
  emoji?: string;
}

interface ChipSelectProps<T extends string> {
  options: ReadonlyArray<ChipOption<T>>;
  value: T[];
  onChange: (next: T[]) => void;
  /** Single-select behaves like radio chips (used by the ad wizard). */
  single?: boolean;
  /** Extra class on the container (e.g. `chips--onb` for larger onboarding chips). */
  className?: string;
  /** Lay chips out on an even grid instead of flowing pills, so rows line up.
   *  `true`/`3` → 3 equal columns (2 on narrow) — the "work type" sets.
   *  `2` → 2 equal columns (1 on very narrow) — the visa sets, whose labels
   *  vary a lot in length ("F-4 (соотечественник)" vs "E-9").
   *  Leave off for short flow sets like fee / freshness. */
  grid?: boolean | 2 | 3;
}

/** Multi- (or single-) select pill group, themed via `.chip`. */
export function ChipSelect<T extends string>({
  options,
  value,
  onChange,
  single = false,
  className,
  grid = false,
}: ChipSelectProps<T>) {
  const toggle = (v: T): void => {
    if (single) {
      onChange(value[0] === v ? [] : [v]);
      return;
    }
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };
  const gridClass = grid === 2 ? 'chips--grid2' : grid ? 'chips--grid' : '';
  return (
    <div className={`chips ${gridClass} ${className ?? ''}`}>
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            className={`chip ${on ? 'chip--on' : ''}`}
            onClick={() => toggle(o.value)}
            aria-pressed={on}
          >
            {o.emoji ? <span aria-hidden>{o.emoji}</span> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
