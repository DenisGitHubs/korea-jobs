import { useEffect } from 'react';
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
 */
export function useMainButton({ text, visible, enabled = true, loading = false, onClick }: MainButtonOptions): void {
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

    if (!visible) return;

    try {
      mainButton.onClick(onClick);
    } catch {
      /* ignore */
    }

    return () => {
      try {
        mainButton.offClick(onClick);
      } catch {
        /* ignore */
      }
      try {
        if (mainButton.setParams.isAvailable()) mainButton.setParams({ isVisible: false });
      } catch {
        /* ignore */
      }
    };
  }, [text, visible, enabled, loading, onClick]);
}
