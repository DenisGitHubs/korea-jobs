/**
 * Drive our own `--kj-*` CSS variables + `<html data-theme>` from one of three
 * user-chosen modes (Settings -> Theme):
 *  - 'auto'  : follow the KOREAN CLOCK (Asia/Seoul) — light during the working
 *              day, dark in the evening/night, "so it doesn't burn the eyes".
 *              NOT the device timezone and NOT the Telegram client theme. Falls
 *              back to the device's local clock only if the WebView can't
 *              resolve the Asia/Seoul zone.
 *  - 'light' : force our own LIGHT_THEME palette.
 *  - 'dark'  : force our own DARK_THEME palette.
 * Native Telegram popups always follow the client theme — the override is
 * in-app only. The Telegram chrome (header/background/bottom-bar) is kept in
 * sync with our base bg via syncChromeColor/syncBottomBarColor after each apply.
 */
import { DARK_THEME, LIGHT_THEME, syncBottomBarColor, syncChromeColor } from './telegram';

export type ThemeMode = 'auto' | 'light' | 'dark';

// 'auto' boundaries on the KOREAN clock (Asia/Seoul), 24h. Light from 08:00 up
// to 19:00; dark from 19:00 up to 08:00 (owner rule, 2026-07-20). The window is
// tied to Korea's working day, not the device timezone, so users abroad still
// see the same day/night split as everyone on the ground.
export const AUTO_LIGHT_FROM_HOUR = 8; // inclusive — light starts here (Seoul)
export const AUTO_DARK_FROM_HOUR = 19; // inclusive — dark starts here (Seoul)

/**
 * Current hour (0–23) on the Korean clock (Asia/Seoul), independent of the
 * device's own timezone. Falls back to the device's local hour if the WebView's
 * Intl engine can't resolve the zone (some older embedded WebViews).
 */
export function seoulHour(now: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(now);
    const raw = parts.find((p) => p.type === 'hour')?.value;
    const h = raw != null ? Number.parseInt(raw, 10) : Number.NaN;
    // hour12:false can emit "24" for midnight on some engines — normalize to 0.
    if (Number.isFinite(h)) return h % 24;
  } catch {
    /* timeZone unsupported — fall through to the device clock */
  }
  return now.getHours();
}

/** True when the Korean-clock time falls inside the "dark" window. */
export function isNightNow(now: Date = new Date()): boolean {
  const h = seoulHour(now);
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
  else dark = isNightNow(); // 'auto' -> by the Korean clock (Asia/Seoul)
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
