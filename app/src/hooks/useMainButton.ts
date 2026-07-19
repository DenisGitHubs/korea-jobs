import { useEffect, useRef } from 'react';
import { mainButton } from '@telegram-apps/sdk-react';

interface MainButtonOptions {
  text: string;
  visible: boolean;
  enabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}

/**
 * Read a live `#rrggbb` brand token from the document so the native MainButton
 * matches our terracotta accent instead of Telegram's default blue. Non-hex
 * values (e.g. color-mix()) are rejected so we never hand the client junk.
 */
function brandColor(name: string): `#${string}` | undefined {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? (v as `#${string}`) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Drive the native Telegram MainButton. No-op in the browser mock; screens also
 * render an in-app primary button so the flow works in a plain browser.
 * The button is painted with our brand accent so it never shows Telegram blue.
 *
 * The click handler is kept in a ref so a changing `onClick` identity (e.g. the
 * filter draft mutating on every tap) only updates the ref — it never tears the
 * button down and re-shows it. That split keeps the button from flickering:
 * label/loader changes are cheap `setParams` calls, while the native click
 * subscription lives for the button's whole visible lifetime.
 */
export function useMainButton({ text, visible, enabled = true, loading = false, onClick }: MainButtonOptions): void {
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;

  // Params effect: push label / visibility / state to the native button. Cheap,
  // may run on every render (text or loader change) without touching the click
  // subscription, so the button just re-labels instead of hiding and re-showing.
  useEffect(() => {
    try {
      if (mainButton.setParams.isAvailable()) {
        const backgroundColor = brandColor('--kj-brand');
        const textColor = brandColor('--kj-brand-ink');
        mainButton.setParams({
          text,
          isVisible: visible,
          isEnabled: enabled,
          isLoaderVisible: loading,
          ...(backgroundColor ? { backgroundColor } : {}),
          ...(textColor ? { textColor } : {}),
        });
      }
    } catch {
      /* ignore */
    }
  }, [text, visible, enabled, loading]);

  // Click effect: a single stable handler for as long as the button is visible.
  // It calls the latest `onClick` via the ref, so a new callback identity does
  // not resubscribe (and does not trigger the hide-on-cleanup below).
  useEffect(() => {
    if (!visible) return;
    const handler = () => onClickRef.current();
    try {
      mainButton.onClick(handler);
    } catch {
      /* ignore */
    }

    return () => {
      try {
        mainButton.offClick(handler);
      } catch {
        /* ignore */
      }
      try {
        if (mainButton.setParams.isAvailable()) mainButton.setParams({ isVisible: false });
      } catch {
        /* ignore */
      }
    };
  }, [visible]);
}
