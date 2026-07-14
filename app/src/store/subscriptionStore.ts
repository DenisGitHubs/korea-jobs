import { create } from 'zustand';
import type { Me, PlacementFee, Subscription, VisaType, WorkType } from '../shared/types/api';

/** The persistent subscription (drives the bot notifications + the feed default). */
export interface SubscriptionValue {
  citySlugs: string[];
  workTypes: WorkType[];
  notify: boolean;
  visaTypes: VisaType[];
  placementFee: PlacementFee | null;
  requireHousing: boolean | null;
  requireMeals: boolean | null;
}

interface SubscriptionState extends SubscriptionValue {
  loaded: boolean;
  publicId: string;
  termsRequired: boolean;
  termsVersion: string;
  hydrate: (m: Me) => void;
  apply: (s: Subscription) => void;
  setNotify: (b: boolean) => void;
  acceptTerms: () => void;
}

const EMPTY: SubscriptionValue = {
  citySlugs: [],
  workTypes: [],
  notify: true,
  visaTypes: [],
  placementFee: null,
  requireHousing: null,
  requireMeals: null,
};

function fromSubscription(s: Subscription): SubscriptionValue {
  return {
    citySlugs: s.city_slugs,
    workTypes: s.work_types as WorkType[],
    notify: s.notify,
    visaTypes: s.visa_types ?? [],
    placementFee: s.placement_fee ?? null,
    requireHousing: s.require_housing ?? null,
    requireMeals: s.require_meals ?? null,
  };
}

/** Read the current subscription slice as a plain SubscriptionValue. */
export function subscriptionValue(s: SubscriptionState): SubscriptionValue {
  return {
    citySlugs: s.citySlugs,
    workTypes: s.workTypes,
    notify: s.notify,
    visaTypes: s.visaTypes,
    placementFee: s.placementFee,
    requireHousing: s.requireHousing,
    requireMeals: s.requireMeals,
  };
}

/** SubscriptionValue -> API Subscription body. */
export function toSubscription(v: SubscriptionValue): Subscription {
  return {
    city_slugs: v.citySlugs,
    work_types: v.workTypes,
    notify: v.notify,
    visa_types: v.visaTypes,
    placement_fee: v.placementFee,
    require_housing: v.requireHousing,
    require_meals: v.requireMeals,
  };
}

export const useSubscriptionStore = create<SubscriptionState>((set) => ({
  ...EMPTY,
  loaded: false,
  publicId: '',
  termsRequired: false,
  termsVersion: '',
  hydrate: (m) =>
    set({
      ...fromSubscription(m.subscription),
      publicId: m.public_id,
      termsRequired: m.terms?.required ?? false,
      termsVersion: m.terms?.version ?? '',
      loaded: true,
    }),
  apply: (s) => set({ ...fromSubscription(s), loaded: true }),
  setNotify: (b) => set({ notify: b }),
  acceptTerms: () => set({ termsRequired: false }),
}));
