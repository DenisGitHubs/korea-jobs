/**
 * Bridge Telegram theme params -> our own `--kj-*` CSS variables, and reflect
 * dark/light on <html data-theme>.
 *
 * Three modes (Settings -> Theme):
 *  - 'auto'  : follow the Telegram client theme (read the SDK theme signals).
 *  - 'light' : force our own LIGHT_THEME palette regardless of themeParams.
 *  - 'dark'  : force our own DARK_THEME palette regardless of themeParams.
 * Native Telegram popups always follow the client theme — the override is
 * in-app only.
 */
import { miniApp, themeParams } from '@telegram-apps/sdk-react';
import { DARK_THEME, LIGHT_THEME, syncBottomBarColor } from './telegram';

export type ThemeMode = 'auto' | 'light' | 'dark';

type ColorSignal = { (): string | undefined; sub(fn: () => void): () => void };
type BoolSignal = { (): boolean | undefined; sub(fn: () => void): () => void };

const tp = themeParams as unknown as Record<string, ColorSignal>;
const isDark = (miniApp as unknown as { isDark: BoolSignal }).isDark;

// SDK signal -> css var (used in 'auto' mode).
const COLOR_VARS: Array<[ColorSignal, string]> = [
  [tp.backgroundColor, '--kj-bg'],
  [tp.textColor, '--kj-text'],
  [tp.hintColor, '--kj-hint'],
  [tp.linkColor, '--kj-link'],
  [tp.buttonColor, '--kj-button'],
  [tp.buttonTextColor, '--kj-button-text'],
  [tp.secondaryBackgroundColor, '--kj-secondary-bg'],
  [tp.headerBackgroundColor, '--kj-header-bg'],
  [tp.accentTextColor, '--kj-accent'],
  [tp.sectionBackgroundColor, '--kj-section-bg'],
  [tp.sectionHeaderTextColor, '--kj-section-header-text'],
  [tp.subtitleTextColor, '--kj-subtitle'],
  [tp.destructiveTextColor, '--kj-destructive'],
  [tp.sectionSeparatorColor, '--kj-separator'],
  [tp.bottomBarBgColor, '--kj-bottom-bar-bg'],
];

// Snake_case theme key -> css var (used in the forced 'light'/'dark' modes).
const FORCED_VARS: Array<[keyof typeof LIGHT_THEME, string]> = [
  ['bg_color', '--kj-bg'],
  ['text_color', '--kj-text'],
  ['hint_color', '--kj-hint'],
  ['link_color', '--kj-link'],
  ['button_color', '--kj-button'],
  ['button_text_color', '--kj-button-text'],
  ['secondary_bg_color', '--kj-secondary-bg'],
  ['header_bg_color', '--kj-header-bg'],
  ['accent_text_color', '--kj-accent'],
  ['section_bg_color', '--kj-section-bg'],
  ['section_header_text_color', '--kj-section-header-text'],
  ['subtitle_text_color', '--kj-subtitle'],
  ['destructive_text_color', '--kj-destructive'],
  ['section_separator_color', '--kj-separator'],
  ['bottom_bar_bg_color', '--kj-bottom-bar-bg'],
];

let currentMode: ThemeMode = 'auto';

function applyAuto(): void {
  const root = document.documentElement;
  for (const [sig, cssVar] of COLOR_VARS) {
    let value: string | undefined;
    try {
      value = typeof sig === 'function' ? sig() : undefined;
    } catch {
      value = undefined;
    }
    if (value) root.style.setProperty(cssVar, value);
  }
  let dark: boolean | undefined;
  try {
    dark = typeof isDark === 'function' ? isDark() : undefined;
  } catch {
    dark = undefined;
  }
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
}

function applyForced(theme: Record<keyof typeof LIGHT_THEME, string>, dark: boolean): void {
  const root = document.documentElement;
  for (const [key, cssVar] of FORCED_VARS) root.style.setProperty(cssVar, theme[key]);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
}

function render(): void {
  if (currentMode === 'light') applyForced(LIGHT_THEME, false);
  else if (currentMode === 'dark') applyForced(DARK_THEME, true);
  else applyAuto();
  syncBottomBarColor();
}

/** Switch theme mode at runtime (from Settings) and re-render immediately. */
export function applyThemeMode(mode: ThemeMode): void {
  currentMode = mode;
  render();
}

/** Apply once and subscribe to live client theme changes. Returns an unsubscribe fn. */
export function initTheme(mode: ThemeMode = 'auto'): () => void {
  currentMode = mode;
  render();

  // Re-render on client theme changes, but only while in 'auto' mode.
  const onChange = (): void => {
    if (currentMode === 'auto') render();
  };
  const unsubs: Array<() => void> = [];
  for (const [sig] of COLOR_VARS) {
    try {
      if (sig && typeof sig.sub === 'function') unsubs.push(sig.sub(onChange));
    } catch {
      /* signal not subscribable in this environment */
    }
  }
  try {
    if (isDark && typeof isDark.sub === 'function') unsubs.push(isDark.sub(onChange));
  } catch {
    /* ignore */
  }
  return () => {
    for (const u of unsubs) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
  };
}
