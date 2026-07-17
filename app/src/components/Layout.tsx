import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { syncBottomBarColor } from '../lib/telegram';
import { useUiStore } from '../store/uiStore';
import { TabBar } from './TabBar';

/** Top-level routes that keep the bottom TabBar (incl. the "Post" wizard). */
const TOP_TABS = ['/feed', '/settings', '/post', '/partners'];

export function Layout() {
  const { pathname } = useLocation();

  // Transient overlays (e.g. the filter sheet with its own MainButton) hide the
  // TabBar via the UI store; every top-level tab otherwise keeps it visible.
  const tabBarHidden = useUiStore((s) => s.tabBarHidden);

  const isTop = TOP_TABS.includes(pathname);
  const showTabBar = isTop && !tabBarHidden;

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
