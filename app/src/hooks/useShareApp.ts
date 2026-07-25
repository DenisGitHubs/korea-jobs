import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { postEvent, shareMessage } from '@telegram-apps/sdk-react';
import { api } from '../shared/api/client';
import { useSettingsStore } from '../store/settingsStore';
import { loadReferral } from '../lib/shareLink';

/**
 * Reusable APP-invite share, extracted verbatim from ReferralScreen so a second
 * entry point (the explicit "Share the app" button in Settings) reuses the exact
 * same card + fallback logic instead of copy-pasting it.
 *
 * Preferred path (Bot API 8.0+): the backend mints a "prepared inline message"
 * (rich invite card) handed to Telegram's native share sheet via WebApp.shareMessage.
 * DEGRADES SILENTLY to the legacy link-share on every failure mode, so nothing
 * regresses on older clients:
 *   • shareMessage.isAvailable() === false → client < 8.0 / unsupported / no SDK env
 *     (the endpoint is never even called), or
 *   • the backend opts out ({ fallback:true }) or returns no preparedMessageId, or
 *   • the endpoint errors / the network fails, or
 *   • the native share dialog rejects (shareMessage promise throws).
 *
 * `shareApp(link?)` — pass the referral link when the caller already has it
 * (ReferralScreen: from GET /referral); omit it and the hook lazily loads it via the
 * memoized `loadReferral` (Settings). Only the link-share FALLBACK needs the link —
 * the prepared-message path is link-free — so an available 8.0 client never waits on it.
 * `shareToast` — transient "Sent" banner the caller renders as a `.ref-toast`.
 */
export function useShareApp() {
  const { t } = useTranslation();
  const isReal = useSettingsStore((s) => s.isReal);
  const [shareToast, setShareToast] = useState<string | null>(null);

  // Auto-dismiss the success banner (mirrors the previous per-screen timers).
  useEffect(() => {
    if (shareToast == null) return;
    const id = window.setTimeout(() => setShareToast(null), 2200);
    return () => window.clearTimeout(id);
  }, [shareToast]);

  // Legacy link-share: opens Telegram's native "share to a chat" sheet; the link
  // travels ONLY in `url` (so it never duplicates inside the text), `text` is the
  // pitch. Browser/mock (or a failed postEvent) → plain t.me open.
  const shareFallback = useCallback(
    (link: string) => {
      const pathFull = `/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(
        t('referral.shareText'),
      )}`;
      try {
        if (isReal) {
          postEvent('web_app_open_tg_link', { path_full: pathFull });
        } else {
          window.open(`https://t.me${pathFull}`, '_blank');
        }
      } catch {
        window.open(`https://t.me${pathFull}`, '_blank');
      }
    },
    [isReal, t],
  );

  const shareApp = useCallback(
    async (link?: string | null) => {
      if (shareMessage.isAvailable()) {
        try {
          const prep = await api.sharePrepare({ kind: 'app' });
          if (prep.ok && !prep.fallback && prep.preparedMessageId) {
            // Resolves on `prepared_message_sent`, rejects on `prepared_message_failed`
            // (or a dismissed dialog) → the catch below falls back.
            await shareMessage(prep.preparedMessageId);
            setShareToast(t('referral.shareSent'));
            return;
          }
        } catch {
          /* backend/network/dialog failure → fall through to the link-share */
        }
      }
      const target = link ?? (await loadReferral())?.link ?? null;
      if (target) shareFallback(target);
    },
    [shareFallback, t],
  );

  return { shareApp, shareToast };
}
