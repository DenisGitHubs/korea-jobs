import { create } from 'zustand';

/** Which feed segment the user last viewed (remembered across navigations). */
export type FeedSegment = 'all' | 'saved' | 'raw';

interface UiState {
  /** Hide the bottom TabBar while an overlay with an active MainButton is open. */
  tabBarHidden: boolean;
  setTabBarHidden: (v: boolean) => void;
  /** Force-open the how-to Tour (replay from Settings, regardless of the seen flag). */
  tourReplay: boolean;
  setTourReplay: (v: boolean) => void;
  /**
   * Last-viewed feed segment (Все / Сохранённые / Не проверено). Persisted in the
   * session store so returning from a card restores the tab (scroll is restored by
   * the feed cache keyed per segment). Resets on a full app reload.
   */
  feedSegment: FeedSegment;
  setFeedSegment: (v: FeedSegment) => void;
}

export const useUiStore = create<UiState>((set) => ({
  tabBarHidden: false,
  setTabBarHidden: (v) => set({ tabBarHidden: v }),
  tourReplay: false,
  setTourReplay: (v) => set({ tourReplay: v }),
  feedSegment: 'all',
  setFeedSegment: (v) => set({ feedSegment: v }),
}));
