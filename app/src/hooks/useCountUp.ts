import { useEffect, useRef, useState } from 'react';

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Animate a whole number from 0 up to `target` on mount (ease-out), then flag a
 * one-shot settle "pop" via the returned class name.
 *
 * Accessibility: under `prefers-reduced-motion: reduce` the final value is shown
 * immediately — no ticking, no pop. Pair the class with `.kj-num--pop` in CSS.
 *
 * Usage:
 *   const [shown, popClass] = useCountUp(points_total);
 *   <span className={`ref-balance__num ${popClass}`}>{shown}</span>
 *
 * @returns `[displayValue, popClassName]`
 */
export function useCountUp(target: number, durationMs = 900): readonly [number, string] {
  const reduced = prefersReducedMotion();
  const [value, setValue] = useState(() => (reduced ? target : 0));
  const [popped, setPopped] = useState(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced || !Number.isFinite(target) || target <= 0) {
      setValue(Number.isFinite(target) ? target : 0);
      setPopped(false);
      return;
    }

    setValue(0);
    setPopped(false);
    const start = performance.now();

    const tick = (now: number): void => {
      const p = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setValue(Math.round(target * eased));
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setValue(target);
        setPopped(true);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs, reduced]);

  return [value, popped ? 'kj-num--pop' : ''] as const;
}
