import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../shared/api/client';
import { syncBottomBarColor } from '../lib/telegram';
import { useUiStore } from '../store/uiStore';
import { useSubscriptionStore } from '../store/subscriptionStore';
import { TabBar } from './TabBar';
import { Modal } from './Modal';

/** Top-level routes that keep the bottom TabBar. */
const TOP_TABS = ['/feed', '/settings', '/post', '/partners'];
/** Routes where an active MainButton owns the bottom — hide the TabBar. */
const MAIN_BUTTON_ROUTES = ['/post'];

export function Layout() {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  const tabBarHidden = useUiStore((s) => s.tabBarHidden);
  const termsRequired = useSubscriptionStore((s) => s.termsRequired);
  const acceptTermsLocal = useSubscriptionStore((s) => s.acceptTerms);
  const [accepting, setAccepting] = useState(false);

  const isTop = TOP_TABS.includes(pathname);
  const showTabBar = isTop && !MAIN_BUTTON_ROUTES.includes(pathname) && !tabBarHidden;

  // Keep the native bottom bar / Android nav bar tinted to our panel color.
  useEffect(() => {
    syncBottomBarColor();
  }, [pathname]);

  const acceptTerms = useCallback(() => {
    setAccepting(true);
    api
      .acceptTerms()
      .catch(() => {
        /* offline / mock unavailable — accept locally so we do not block the app */
      })
      .finally(() => {
        acceptTermsLocal();
        setAccepting(false);
      });
  }, [acceptTermsLocal]);

  return (
    <div className="app-root">
      <Outlet />
      {showTabBar ? <TabBar /> : null}

      <Modal
        open={termsRequired}
        title={t('terms.title')}
        actions={
          <button className="btn btn--primary btn--block" onClick={acceptTerms} disabled={accepting}>
            {accepting ? t('common.saving') : t('terms.accept')}
          </button>
        }
      >
        <p className="modal__text">{t('terms.body')}</p>
      </Modal>
    </div>
  );
}
