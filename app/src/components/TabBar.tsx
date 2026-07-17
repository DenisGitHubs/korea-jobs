import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/* Inline line-icons (24×24). Stroke/fill/width come from `.tabbar__ico`.
   Geometry is taken from the approved Liquid-Glass prototype sprite. */
const IconFeed: ReactNode = (
  <svg className="tabbar__ico" viewBox="0 0 24 24" aria-hidden>
    <rect width="8" height="4" x="8" y="2" rx="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <path d="M12 11h4" />
    <path d="M12 16h4" />
    <path d="M8 11h.01" />
    <path d="M8 16h.01" />
  </svg>
);

const IconSettings: ReactNode = (
  <svg className="tabbar__ico" viewBox="0 0 24 24" aria-hidden>
    <line x1="21" y1="6" x2="11" y2="6" />
    <line x1="6" y1="6" x2="3" y2="6" />
    <circle cx="8.5" cy="6" r="2" />
    <line x1="21" y1="12" x2="15" y2="12" />
    <line x1="10" y1="12" x2="3" y2="12" />
    <circle cx="12.5" cy="12" r="2" />
    <line x1="21" y1="18" x2="17" y2="18" />
    <line x1="12" y1="18" x2="3" y2="18" />
    <circle cx="14.5" cy="18" r="2" />
  </svg>
);

const IconPost: ReactNode = (
  <svg className="tabbar__ico" viewBox="0 0 24 24" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <line x1="12" y1="8" x2="12" y2="16" />
    <line x1="8" y1="12" x2="16" y2="12" />
  </svg>
);

const IconPartners: ReactNode = (
  <svg className="tabbar__ico" viewBox="0 0 24 24" aria-hidden>
    <rect width="18" height="12" x="3" y="8" rx="2" />
    <path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M3 13h18" />
  </svg>
);

const TABS: ReadonlyArray<{ to: string; icon: ReactNode; key: string }> = [
  { to: '/feed', icon: IconFeed, key: 'tab.feed' },
  { to: '/settings', icon: IconSettings, key: 'tab.settings' },
  { to: '/post', icon: IconPost, key: 'tab.post' },
  { to: '/partners', icon: IconPartners, key: 'tab.partners' },
];

/** Persistent 4-tab bottom navigation (floating glass capsule). */
export function TabBar() {
  const { t } = useTranslation();
  return (
    <nav className="tabbar">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          className={({ isActive }) => `tabbar__item ${isActive ? 'tabbar__item--on' : ''}`}
        >
          {tab.icon}
          <span className="tabbar__label">{t(tab.key)}</span>
        </NavLink>
      ))}
    </nav>
  );
}
