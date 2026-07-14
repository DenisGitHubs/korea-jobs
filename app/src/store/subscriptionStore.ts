import { create } from 'zustand';
import type { Me, Subscription, WorkType } from '../shared/types/api';

interface SubscriptionState {
  citySlugs: string[];
  workTypes: WorkType[];
  notify: boolean;
  loaded: boolean;
  hydrate: (m: Me) => void;
  apply: (s: Subscription) => void;
  setNotify: (b: boolean) => void;
}

export const useSubscriptionStore = create<SubscriptionState>((set) => ({
  citySlugs: [],
  workTypes: [],
  notify: true,
  loaded: false,
  hydrate: (m) =>
    set({
      citySlugs: m.subscription.city_slugs,
      workTypes: m.subscription.work_types as WorkType[],
      notify: m.subscription.notify,
      loaded: true,
    }),
  apply: (s) =>
    set({
      citySlugs: s.city_slugs,
      workTypes: s.work_types as WorkType[],
      notify: s.notify,
      loaded: true,
    }),
  setNotify: (b) => set({ notify: b }),
}));
