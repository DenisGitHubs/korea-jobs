import { create } from 'zustand';
import type { VacancyView } from '../shared/types/api';

/** A cached feed page-set, keyed by the filter signature. */
export interface FeedCache {
  items: VacancyView[];
  cursor: string | null;
  hasMore: boolean;
  /** Vertical scroll offset to restore when returning to the feed. */
  scrollY: number;
}

interface FeedState {
  caches: Record<string, FeedCache>;
  get: (sig: string) => FeedCache | undefined;
  set: (sig: string, cache: FeedCache) => void;
  patch: (sig: string, patch: Partial<FeedCache>) => void;
  clear: () => void;
}

/**
 * Keeps the feed alive across tab switches and detail navigation. The cache is
 * keyed by the applied filter signature, so changing the filter fetches fresh.
 */
export const useFeedStore = create<FeedState>((set, get) => ({
  caches: {},
  get: (sig) => get().caches[sig],
  set: (sig, cache) => set((s) => ({ caches: { ...s.caches, [sig]: cache } })),
  patch: (sig, patch) =>
    set((s) => {
      const prev = s.caches[sig];
      if (!prev) return s;
      return { caches: { ...s.caches, [sig]: { ...prev, ...patch } } };
    }),
  clear: () => set({ caches: {} }),
}));
