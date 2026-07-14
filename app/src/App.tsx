import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './shared/api/client';
import { useSubscriptionStore } from './store/subscriptionStore';
import { Splash } from './components/Splash';
import { Layout } from './components/Layout';
import FeedScreen from './screens/FeedScreen';
import VacancyScreen from './screens/VacancyScreen';
import SettingsScreen from './screens/SettingsScreen';
import PostScreen from './screens/PostScreen';
import PartnersScreen from './screens/PartnersScreen';

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
        // Live API unavailable — start empty so the feed still opens (shows all).
        if (alive) {
          hydrate({
            public_id: '',
            lang: 'ru',
            terms: { required: false, version: '' },
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
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/feed" replace />} />
          <Route path="feed" element={<FeedScreen />} />
          <Route path="feed/:id" element={<VacancyScreen />} />
          <Route path="settings" element={<SettingsScreen />} />
          <Route path="post" element={<PostScreen />} />
          <Route path="partners" element={<PartnersScreen />} />
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
