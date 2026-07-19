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
  /** Lay chips out on an even 3-col grid (2 on narrow) instead of flowing pills.
   *  Used for the "work type" sets so rows line up; leave off for short flow sets
   *  like visa / fee / freshness. */
  grid?: boolean;
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
  return (
    <div className={`chips ${grid ? 'chips--grid' : ''} ${className ?? ''}`}>
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
