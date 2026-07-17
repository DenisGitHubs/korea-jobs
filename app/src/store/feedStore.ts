import { create } from 'zustand';
import type { RawView, VacancyView } from '../shared/types/api';

/** Feed item: a vacancy (All/Saved segments) or a raw listing (Не разобрано). */
export type FeedItem = VacancyView | RawView;

/** A cached feed page-set, keyed by segment + filter signature. */
export interface FeedCache {
  items: FeedItem[];
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
  /** Drop one cache entry (e.g. force the Saved list to refetch after a new save). */
  drop: (sig: string) => void;
  /** Reflect a save toggle across ALL cached segments (flag sync + drop from Saved). */
  setSaved: (id: string, isSaved: boolean) => void;
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
  drop: (sig) =>
    set((s) => {
      if (!(sig in s.caches)) return s;
      const rest = { ...s.caches };
      delete rest[sig];
      return { caches: rest };
    }),
  setSaved: (id, isSaved) =>
    set((s) => {
      const caches: Record<string, FeedCache> = {};
      for (const [key, c] of Object.entries(s.caches)) {
        let items = c.items.map((it) =>
          it.id === id && it.source_kind !== 'raw' ? { ...it, is_saved: isSaved } : it,
        );
        // Removing a bookmark drops it from the Saved segment immediately.
        if (key === 'saved' && !isSaved) items = items.filter((it) => it.id !== id);
        caches[key] = { ...c, items };
      }
      return { caches };
    }),
  clear: () => set({ caches: {} }),
}));

/**
 * Optimistically reflect a save toggle across all cached segments. Adding a
 * bookmark also drops the Saved cache so it refetches and includes the new item.
 * Shared by FeedScreen and VacancyScreen so the two paths stay identical.
 */
export function applySaveToCaches(id: string, isSaved: boolean): void {
  const s = useFeedStore.getState();
  s.setSaved(id, isSaved);
  if (isSaved) s.drop('saved');
}

/**
 * Revert a FAILED save toggle. Always drops the Saved cache: a failed UNSAVE from
 * the Saved segment already filtered the item out, and setSaved's map cannot
 * re-add it — so refetch from the server instead of keeping a stale list.
 */
export function revertSaveInCaches(id: string, original: boolean): void {
  const s = useFeedStore.getState();
  s.setSaved(id, original);
  s.drop('saved');
}
