import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface AppBarProps {
  title: string;
  onBack?: () => void;
  left?: ReactNode;
  right?: ReactNode;
}

export function AppBar({ title, onBack, left, right }: AppBarProps) {
  const { t } = useTranslation();
  // Always render an explicit in-app "Назад" on any sub-screen that provides onBack.
  // Previously this was shown only in the browser mock and real Telegram relied on the
  // native BackButton — but that native control is not reliably visible on every client
  // (users got stuck with no way back), so we always show a clear in-app back control.
  const showBack = Boolean(onBack);

  return (
    <header className="appbar">
      <div className="appbar__slot">
        {showBack ? (
          <button className="appbar__btn" onClick={onBack} aria-label={t('nav.back')}>
            <span aria-hidden>‹</span>
            {t('nav.back')}
          </button>
        ) : (
          left ?? null
        )}
      </div>
      <div className="appbar__title">{title}</div>
      <div className="appbar__slot appbar__slot--right">{right}</div>
    </header>
  );
}
