import { create } from 'zustand';

interface UiState {
  /** Hide the bottom TabBar while an overlay with an active MainButton is open. */
  tabBarHidden: boolean;
  setTabBarHidden: (v: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  tabBarHidden: false,
  setTabBarHidden: (v) => set({ tabBarHidden: v }),
}));
