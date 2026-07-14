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
 * Drive the native Telegram MainButton. No-op in the browser mock; screens also
 * render an in-app primary button so the flow works in a plain browser.
 */
export function useMainButton({ text, visible, enabled = true, loading = false, onClick }: MainButtonOptions): void {
  useEffect(() => {
    try {
      if (mainButton.setParams.isAvailable()) {
        mainButton.setParams({ text, isVisible: visible, isEnabled: enabled, isLoaderVisible: loading });
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
