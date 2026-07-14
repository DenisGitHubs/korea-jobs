import { useEffect } from 'react';
import { backButton } from '@telegram-apps/sdk-react';

/**
 * Drive the native Telegram BackButton. No-op in the browser mock (there is no
 * native chrome), where the in-app back control is used instead.
 */
export function useBackButton(visible: boolean, onClick: () => void): void {
  useEffect(() => {
    if (!visible) {
      try {
        if (backButton.hide.isAvailable()) backButton.hide();
      } catch {
        /* ignore */
      }
      return;
    }

    try {
      if (backButton.show.isAvailable()) backButton.show();
    } catch {
      /* ignore */
    }
    try {
      backButton.onClick(onClick);
    } catch {
      /* ignore */
    }

    return () => {
      try {
        backButton.offClick(onClick);
      } catch {
        /* ignore */
      }
      try {
        if (backButton.hide.isAvailable()) backButton.hide();
      } catch {
        /* ignore */
      }
    };
  }, [visible, onClick]);
}
