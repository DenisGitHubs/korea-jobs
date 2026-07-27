import { postEvent } from '@telegram-apps/sdk-react';

/**
 * The project's own bot — the single, public way to reach us. Named here once so
 * the UI and the legal texts (content/legal/*) point at the very same handle.
 */
export const SUPPORT_BOT = 'korea_rabota_bot';

/**
 * Open a chat with our bot ("Contact us").
 *
 * Same mechanism as the share fallback / "write to the author" on a vacancy: in a
 * real client we post a RAW `web_app_open_tg_link` with a relative `path_full`
 * (bypasses the SDK's desktop window.open fallback, tma.js #712); in the browser
 * mock — a plain t.me tab. Any throw degrades to the browser path.
 */
export function openSupportChat(isReal: boolean): void {
  const pathFull = `/${SUPPORT_BOT}`;
  try {
    if (isReal) {
      postEvent('web_app_open_tg_link', { path_full: pathFull });
    } else {
      window.open(`https://t.me${pathFull}`, '_blank');
    }
  } catch {
    window.open(`https://t.me${pathFull}`, '_blank');
  }
}
