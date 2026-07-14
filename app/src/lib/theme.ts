/**
 * Bridge Telegram theme params -> our own `--kj-*` CSS variables, and reflect
 * dark/light on <html data-theme>. We read the SDK's individual theme signals
 * (deterministic) instead of themeParams.bindCssVars(), whose emitted names are
 * remapped to the SDK's camelCase and are awkward to consume from CSS.
 */
import { miniApp, themeParams } from '@telegram-apps/sdk-react';

type ColorSignal = { (): string | undefined; sub(fn: () => void): () => void };
type BoolSignal = { (): boolean | undefined; sub(fn: () => void): () => void };

const tp = themeParams as unknown as Record<string, ColorSignal>;
const isDark = (miniApp as unknown as { isDark: BoolSignal }).isDark;

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

function applyTheme(): void {
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

/** Apply once and subscribe to live theme changes. Returns an unsubscribe fn. */
export function initTheme(): () => void {
  applyTheme();
  const unsubs: Array<() => void> = [];
  for (const [sig] of COLOR_VARS) {
    try {
      if (sig && typeof sig.sub === 'function') unsubs.push(sig.sub(applyTheme));
    } catch {
      /* signal not subscribable in this environment */
    }
  }
  try {
    if (isDark && typeof isDark.sub === 'function') unsubs.push(isDark.sub(applyTheme));
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
