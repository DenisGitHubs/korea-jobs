import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { syncBottomBarColor } from '../lib/telegram';
import { useUiStore } from '../store/uiStore';
import { TabBar } from './TabBar';

/** Top-level routes that keep the bottom TabBar. */
const TOP_TABS = ['/feed', '/settings', '/post', '/partners'];
/** Routes where an active MainButton owns the bottom — hide the TabBar. */
const MAIN_BUTTON_ROUTES = ['/post'];

export function Layout() {
  const { pathname } = useLocation();

  const tabBarHidden = useUiStore((s) => s.tabBarHidden);

  const isTop = TOP_TABS.includes(pathname);
  const showTabBar = isTop && !MAIN_BUTTON_ROUTES.includes(pathname) && !tabBarHidden;

  // Keep the native bottom bar / Android nav bar tinted to our panel color.
  useEffect(() => {
    syncBottomBarColor();
  }, [pathname]);

  // Terms acceptance now lives in <ConsentGate/> (shown before onboarding), so the
  // shell no longer renders a terms modal here.
  return (
    <div className="app-root">
      <Outlet />
      {showTabBar ? <TabBar /> : null}
    </div>
  );
}
