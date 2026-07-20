import { useEffect, useLayoutEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, USE_MOCK } from './shared/api/client';
import { useSubscriptionStore } from './store/subscriptionStore';
import { Splash } from './components/Splash';
import { Layout } from './components/Layout';
import { ConsentGate } from './components/ConsentGate';
import { Onboarding } from './components/Onboarding';
import { Tour } from './components/Tour';
import FeedScreen from './screens/FeedScreen';
import VacancyScreen from './screens/VacancyScreen';
import SettingsScreen from './screens/SettingsScreen';
import PostScreen from './screens/PostScreen';
import PartnersScreen from './screens/PartnersScreen';
import ReferralScreen from './screens/ReferralScreen';
import SafetyScreen from './screens/SafetyScreen';
import PrivacyScreen from './screens/PrivacyScreen';
import RulesScreen from './screens/RulesScreen';

/**
 * Reset scroll to the top on every route change. The shell scrolls the document
 * (`.app` is min-height:100dvh with no inner overflow), but we also zero any
 * scrollable `.screen`/`.app-root` container defensively so sub-screens
 * (safety, privacy, rules, referral, feed/:id) always open from the top.
 */
function ScrollToTop() {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    const doc = document.scrollingElement;
    if (doc) doc.scrollTop = 0;
    document.querySelectorAll<HTMLElement>('.screen, .app-root').forEach((el) => {
      el.scrollTop = 0;
    });
  }, [pathname]);
  return null;
}

export default function App() {
  const loaded = useSubscriptionStore((s) => s.loaded);
  const hydrate = useSubscriptionStore((s) => s.hydrate);

  useEffect(() => {
    let alive = true;
    api
      .me()
      .then((m) => {
        if (alive) hydrate(m);
      })
      .catch(() => {
        if (!alive) return;
        // Mock/dev has no backend, so consent does not apply there and we can start
        // empty. On a REAL API error (network / cold start / stale initData / 5xx) we
        // FAIL CLOSED: keep terms required so ConsentGate blocks the app instead of
        // silently skipping the mandatory consent.
        hydrate({
          public_id: '',
          lang: 'ru',
          terms: { required: !USE_MOCK, version: '' },
          points_total: 0,
          onboarded: true,
          subscription: {
            city_slugs: [],
            work_types: [],
            notify: true,
            visa_types: [],
            placement_fee: null,
            require_housing: null,
            require_meals: null,
          },
        });
      });
    return () => {
      alive = false;
    };
  }, [hydrate]);

  if (!loaded) return <Splash />;

  return (
    <BrowserRouter>
      <ScrollToTop />
      {/* Order matters: consent must be granted before onboarding collects any
          preferences; onboarding (guarded by !termsRequired) then runs before the app. */}
      <ConsentGate />
      <Onboarding />
      {/* Runs after onboarding is done (guarded inside): the how-to tour, once. */}
      <Tour />
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/feed" replace />} />
          <Route path="feed" element={<FeedScreen />} />
          <Route path="feed/:id" element={<VacancyScreen />} />
          <Route path="settings" element={<SettingsScreen />} />
          <Route path="post" element={<PostScreen />} />
          <Route path="partners" element={<PartnersScreen />} />
          <Route path="referral" element={<ReferralScreen />} />
          <Route path="safety" element={<SafetyScreen />} />
          <Route path="privacy" element={<PrivacyScreen />} />
          <Route path="rules" element={<RulesScreen />} />
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
