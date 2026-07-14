import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './shared/api/client';
import { useSubscriptionStore } from './store/subscriptionStore';
import { Splash } from './components/Splash';
import FilterScreen from './screens/FilterScreen';
import FeedScreen from './screens/FeedScreen';
import VacancyScreen from './screens/VacancyScreen';
import SettingsScreen from './screens/SettingsScreen';

/** First screen: onboarding (Filter) until the user has chosen cities, then Feed. */
function StartRedirect() {
  const hasCities = useSubscriptionStore((s) => s.citySlugs.length > 0);
  return <Navigate to={hasCities ? '/feed' : '/filter'} replace />;
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
        // Live API unavailable — start empty so onboarding can run.
        if (alive) {
          hydrate({
            public_id: '',
            lang: 'ru',
            subscription: { city_slugs: [], work_types: [], notify: true },
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [hydrate]);

  if (!loaded) return <Splash />;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<StartRedirect />} />
        <Route path="/filter" element={<FilterScreen />} />
        <Route path="/feed" element={<FeedScreen />} />
        <Route path="/vacancy/:id" element={<VacancyScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
