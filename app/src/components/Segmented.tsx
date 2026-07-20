import { useLayoutEffect, useRef, useState } from 'react';

interface SegOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Segmented control with a floating pill indicator that slides between options
 * with a spring. The pill is measured from the real option geometry (offsetLeft /
 * offsetWidth), so it lines up whether options are equal-width (feed / tabs) or
 * auto-width (theme / language). Re-measures on resize and on selection change.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: Array<SegOption<T>>;
  onChange: (v: T) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  const index = options.findIndex((o) => o.value === value);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || index < 0) {
      setPill(null);
      return;
    }
    const measure = (): void => {
      const btn = root.querySelectorAll<HTMLElement>('.segmented__opt')[index];
      if (btn) setPill({ left: btn.offsetLeft, width: btn.offsetWidth });
    };
    measure();
    // Track width changes (viewport resize, font swap, label length changes).
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [index, options.length]);

  return (
    <div ref={ref} className={`segmented ${className ?? ''}`} role="tablist">
      {pill ? (
        <span
          className="segmented__pill"
          aria-hidden
          style={{ transform: `translateX(${pill.left}px)`, width: pill.width }}
        />
      ) : null}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={`segmented__opt ${o.value === value ? 'segmented__opt--on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
