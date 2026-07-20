/**
 * Drive our own `--kj-*` CSS variables + `<html data-theme>` from one of three
 * user-chosen modes (Settings -> Theme):
 *  - 'auto'  : follow the DEVICE CLOCK — light during the day, dark in the
 *              evening/night, "so it doesn't burn the eyes". NOT the Telegram
 *              client theme.
 *  - 'light' : force our own LIGHT_THEME palette.
 *  - 'dark'  : force our own DARK_THEME palette.
 * Native Telegram popups always follow the client theme — the override is
 * in-app only. The Telegram chrome (header/background/bottom-bar) is kept in
 * sync with our base bg via syncChromeColor/syncBottomBarColor after each apply.
 */
import { DARK_THEME, LIGHT_THEME, syncBottomBarColor, syncChromeColor } from './telegram';

export type ThemeMode = 'auto' | 'light' | 'dark';

// 'auto' boundaries on the device's local clock (24h). Light from 07:00 up to
// 20:00; dark from 20:00 up to 07:00. Picked from the UX read (Вася): 20:00 is
// early enough that late-evening phone use in a dim room isn't a white glare,
// and 07:00 keeps early factory shifts on the softer dark screen a touch longer.
export const AUTO_LIGHT_FROM_HOUR = 7; // inclusive — light starts here
export const AUTO_DARK_FROM_HOUR = 20; // inclusive — dark starts here

/** True when the device local time falls inside the "dark" window. */
export function isNightNow(now: Date = new Date()): boolean {
  const h = now.getHours();
  return h < AUTO_LIGHT_FROM_HOUR || h >= AUTO_DARK_FROM_HOUR;
}

// Snake_case theme key -> css var.
const THEME_VARS: Array<[keyof typeof LIGHT_THEME, string]> = [
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

function applyPalette(theme: Record<keyof typeof LIGHT_THEME, string>, dark: boolean): void {
  const root = document.documentElement;
  for (const [key, cssVar] of THEME_VARS) root.style.setProperty(cssVar, theme[key]);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
}

function render(): void {
  let dark: boolean;
  if (currentMode === 'light') dark = false;
  else if (currentMode === 'dark') dark = true;
  else dark = isNightNow(); // 'auto' -> by device clock
  applyPalette(dark ? DARK_THEME : LIGHT_THEME, dark);
  syncBottomBarColor();
  syncChromeColor();
}

/** Switch theme mode at runtime (from Settings) and re-render immediately. */
export function applyThemeMode(mode: ThemeMode): void {
  currentMode = mode;
  render();
}

/**
 * Apply once and, for 'auto', re-evaluate the clock only when the app regains
 * focus/visibility (e.g. reopened later in the evening). We deliberately do NOT
 * flip the theme on a timer mid-session — a live recolour while the user is
 * reading a card is jarring (UX call). Returns an unsubscribe fn.
 */
export function initTheme(mode: ThemeMode = 'auto'): () => void {
  currentMode = mode;
  render();

  const reEval = (): void => {
    if (currentMode === 'auto' && document.visibilityState !== 'hidden') render();
  };
  document.addEventListener('visibilitychange', reEval);
  window.addEventListener('focus', reEval);
  return () => {
    document.removeEventListener('visibilitychange', reEval);
    window.removeEventListener('focus', reEval);
  };
}
