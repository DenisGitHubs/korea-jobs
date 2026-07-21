import { create } from 'zustand';
import type { PlacementFee, VacancyQuery, VisaType, WorkType } from '../shared/types/api';
import type { SubscriptionValue } from './subscriptionStore';

/** Temporary feed filter. Defaults from the subscription; resets on app reload. */
export interface FilterValue {
  cities: string[];
  workTypes: WorkType[];
  visa: VisaType[];
  paid: PlacementFee | null; // 'free' | 'paid' | null(=all); 'unknown' never used as a filter value
  housing: boolean;
  meals: boolean;
  /** Keyword string as typed ("слово. слово"); passed through as `q`. */
  keywords: string;
  freshness: 1 | 3 | 7 | 14 | null;
  /** Also include offers with no city. Acts only when `cities` is non-empty;
   *  with no cities selected the whole feed is shown and this is ignored. */
  noCity: boolean;
}

interface FilterState {
  value: FilterValue;
  initialized: boolean;
  /** Seed the default from the persistent subscription (once per app load). */
  initFromSubscription: (s: SubscriptionValue) => void;
  apply: (v: FilterValue) => void;
  reset: () => void;
}

export const EMPTY_FILTER: FilterValue = {
  cities: [],
  workTypes: [],
  visa: [],
  paid: null,
  housing: false,
  meals: false,
  keywords: '',
  freshness: null,
  noCity: true,
};

export function filterFromSubscription(s: SubscriptionValue): FilterValue {
  return {
    // Seed the temporary feed filter from the persistent subscription: the feed
    // opens from the saved cities (and the "no city" preference) by default.
    cities: [...s.citySlugs],
    workTypes: [...s.workTypes],
    visa: [...s.visaTypes],
    paid: s.placementFee === 'free' || s.placementFee === 'paid' ? s.placementFee : null,
    housing: s.requireHousing === true,
    meals: s.requireMeals === true,
    keywords: '',
    freshness: null,
    noCity: s.noCity,
  };
}

/** Whether the filter narrows anything (used to badge the filter button). */
export function isFilterActive(v: FilterValue): boolean {
  return (
    v.cities.length > 0 ||
    v.workTypes.length > 0 ||
    v.visa.length > 0 ||
    v.paid !== null ||
    v.housing ||
    v.meals ||
    v.keywords.trim().length > 0 ||
    v.freshness !== null
  );
}

/** Stable cache signature for the feed store. */
export function filterSignature(v: FilterValue): string {
  return JSON.stringify({
    c: [...v.cities].sort(),
    w: [...v.workTypes].sort(),
    vi: [...v.visa].sort(),
    p: v.paid,
    h: v.housing,
    m: v.meals,
    q: v.keywords.trim().toLowerCase(),
    f: v.freshness,
    // no_city only affects results while a city is selected — keep it out of the
    // signature otherwise, so toggling it with no cities never churns the cache.
    nc: v.cities.length ? v.noCity : true,
  });
}

/** Map the filter to the GET /vacancies query. */
export function filterToQuery(v: FilterValue): VacancyQuery {
  return {
    cities: v.cities.length ? v.cities : undefined,
    work_types: v.workTypes.length ? v.workTypes : undefined,
    visa: v.visa.length ? v.visa : undefined,
    paid: v.paid === 'free' || v.paid === 'paid' ? v.paid : undefined,
    housing: v.housing || undefined,
    meals: v.meals || undefined,
    q: v.keywords.trim() ? v.keywords.trim() : undefined,
    freshness: v.freshness ?? undefined,
    // Only meaningful with a city selected (server ignores it otherwise).
    no_city: v.cities.length ? v.noCity : undefined,
  };
}

export const useFilterStore = create<FilterState>((set) => ({
  value: EMPTY_FILTER,
  initialized: false,
  initFromSubscription: (s) =>
    set((state) => (state.initialized ? state : { value: filterFromSubscription(s), initialized: true })),
  apply: (v) => set({ value: v, initialized: true }),
  reset: () => set({ value: EMPTY_FILTER }),
}));
