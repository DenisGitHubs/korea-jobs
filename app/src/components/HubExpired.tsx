import { useTranslation } from 'react-i18next';
import { EmptyState } from './EmptyState';
import { IconClock } from './icons/StateIcons';

/**
 * "This sign-in expired" — the terminal end of the AppHub Studio door.
 *
 * Three ways to get here, all of them meaning the same thing for the visitor:
 *   * the pass ran out while the tab sat open (every request now 401s — the
 *     client reports the first one and the app is replaced by this screen,
 *     instead of a feed that is empty and buttons that do nothing, forever);
 *   * the tab was reloaded after that (ticket single use, fragment wiped);
 *   * the exchange itself was refused with a 4xx — the ticket is worth 60
 *     seconds and only the shell can mint another one.
 *
 * The text names exactly ONE cure and does not explain which of the three it
 * was: "why" changes nothing here, and "you took too long" would be blame.
 *
 * The button is `common.close` — the same word the rest of the app uses, no new
 * dictionary key for it. window.close() only works on a window that scripts
 * opened; when the browser refuses, nothing happens and the screen stays up
 * with its text, which is honest — a button that promised more would not be.
 */
export function HubExpired() {
  const { t } = useTranslation();
  return (
    <div className="outside">
      <main className="outside__card">
        <EmptyState
          icon={<IconClock />}
          title={t('hub.expired.title')}
          subtitle={t('hub.expired.lead', { app: t('app.title') })}
          actionLabel={t('common.close')}
          onAction={() => {
            try {
              window.close();
            } catch {
              /* browser refused — the screen stays, with the text above */
            }
          }}
        />
      </main>
    </div>
  );
}
