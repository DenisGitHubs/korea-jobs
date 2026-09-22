import { useTranslation } from 'react-i18next';
import { EmptyState } from './EmptyState';
import { IconWarn } from './icons/StateIcons';

/**
 * "Our service is down" — shown when the AppHub Studio ticket could not be
 * traded because OUR side failed: 503 (the hub key is not configured on this
 * deployment), any other 5xx, or no network at all.
 *
 * It exists because the alternative was worse than nothing: every refusal used
 * to land on <OutsideTelegram/>, a page whose whole content is one big "Open in
 * Telegram" link. Inside the shell's own Chrome window that link may not open
 * anything, and it blames the visitor for a mistake he did not make — a typo in
 * an environment variable on our side. So: the cause named honestly, no blame,
 * and the ONE move that can actually work — try again (the ticket is kept in
 * memory, so the retry needs no reload and no new link).
 *
 * If the ticket has meanwhile run out of its 60 seconds, the retry comes back
 * 4xx and the visitor lands on <HubExpired/> instead — which names the only
 * cure left. Both screens are deliberately dead ends for data: no feed, no
 * requests, nothing that could 401 underneath.
 */
export function HubDown({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="outside">
      <main className="outside__card">
        <EmptyState
          icon={<IconWarn />}
          title={t('hub.down.title')}
          subtitle={t('hub.down.lead')}
          actionLabel={t('hub.down.retry')}
          onAction={onRetry}
        />
      </main>
    </div>
  );
}
