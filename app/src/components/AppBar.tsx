import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../store/settingsStore';

interface AppBarProps {
  title: string;
  onBack?: () => void;
  left?: ReactNode;
  right?: ReactNode;
}

export function AppBar({ title, onBack, left, right }: AppBarProps) {
  const { t } = useTranslation();
  const isReal = useSettingsStore((s) => s.isReal);
  // In a real Telegram client the native BackButton covers navigation, so we
  // only render the in-app back control in the browser (mock).
  const showBack = Boolean(onBack) && !isReal;

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
