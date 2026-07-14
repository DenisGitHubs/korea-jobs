import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const TABS = [
  { to: '/feed', emoji: '📋', key: 'tab.feed' },
  { to: '/settings', emoji: '⚙️', key: 'tab.settings' },
  { to: '/post', emoji: '➕', key: 'tab.post' },
  { to: '/partners', emoji: '🤝', key: 'tab.partners' },
] as const;

/** Persistent 4-tab bottom navigation. */
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
          <span className="tabbar__emoji" aria-hidden>
            {tab.emoji}
          </span>
          <span className="tabbar__label">{t(tab.key)}</span>
        </NavLink>
      ))}
    </nav>
  );
}
