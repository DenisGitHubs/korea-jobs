import { useEffect } from 'react';
import { swipeBehavior, viewport } from '@telegram-apps/sdk-react';

/**
 * Long, scrolling legal sub-screens (Privacy / Rules). Two Telegram-specific
 * concerns (per platform guidance, Bot API 7.7+):
 *
 *  1. Disable vertical swipes so dragging the long text does not collapse/close
 *     the Mini App. Restored on unmount so the rest of the app keeps its normal
 *     swipe-to-close.
 *  2. Expand the viewport so short documents still fill the sheet.
 *
 * Everything is guarded with isAvailable()/try-catch → a plain no-op in the
 * browser mock and on older clients that do not support these methods.
 */
export function useDocViewport(): void {
  useEffect(() => {
    let disabled = false;

    try {
      if (swipeBehavior.mount.isAvailable() && !swipeBehavior.isMounted()) {
        swipeBehavior.mount();
      }
    } catch {
      /* scope unsupported — ignore */
    }
    try {
      if (swipeBehavior.disableVertical.isAvailable()) {
        swipeBehavior.disableVertical();
        disabled = true;
      }
    } catch {
      /* ignore */
    }
    try {
      if (viewport.expand.isAvailable()) viewport.expand();
    } catch {
      /* ignore */
    }

    return () => {
      if (!disabled) return;
      try {
        if (swipeBehavior.enableVertical.isAvailable()) swipeBehavior.enableVertical();
      } catch {
        /* ignore */
      }
    };
  }, []);
}
