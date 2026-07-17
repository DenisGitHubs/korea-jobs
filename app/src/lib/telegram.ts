/**
 * Telegram environment bootstrap.
 *
 * - Real Telegram client: init the SDK and mount the scopes we use.
 * - Plain browser (dev): install a mock env (like the official template) so the
 *   app renders and the SDK does not hang waiting for a native client. The mock
 *   also carries a full 14-key theme (light or dark by prefers-color-scheme) so
 *   the theming path is exercised in the browser.
 *
 * Imported for side effects from main.tsx BEFORE React mounts.
 */
import {
  backButton,
  init,
  initData,
  isTMA,
  mainButton,
  miniApp,
  mockTelegramEnv,
  retrieveLaunchParams,
  secondaryButton,
  themeParams,
  viewport,
  type RetrieveLPResult,
} from '@telegram-apps/sdk-react';

export interface LaunchContext {
  languageCode?: string;
  /** Telegram @username without the leading @ (for prefilling contact fields). */
  username?: string;
  /** True inside a real Telegram client (not the browser mock). */
  isReal: boolean;
}

// Telegram theme params (snake_case keys, exactly as a real client sends them).
// Exported so the Settings "Light/Dark" override can force a palette regardless
// of the client's themeParams (see lib/theme.ts).
export const LIGHT_THEME = {
  bg_color: '#ffffff',
  text_color: '#0f0f10',
  hint_color: '#86868c',
  link_color: '#2481cc',
  button_color: '#2481cc',
  button_text_color: '#ffffff',
  secondary_bg_color: '#f1f1f6',
  header_bg_color: '#ffffff',
  accent_text_color: '#2481cc',
  section_bg_color: '#ffffff',
  section_header_text_color: '#6d6d72',
  subtitle_text_color: '#8e8e93',
  destructive_text_color: '#ff3b30',
  section_separator_color: '#e6e6ea',
  bottom_bar_bg_color: '#f7f7f9',
} as const;

// Forced-dark palette: a real 4-step lightness ladder so cards sit ABOVE the
// page (bottom-bar #0c1218 < bg #10161d < secondary #1a222c < section #212b37).
export const DARK_THEME = {
  bg_color: '#10161d',
  text_color: '#f2f3f5',
  hint_color: '#8c99a6',
  link_color: '#6ab3f3',
  button_color: '#5288c1',
  button_text_color: '#ffffff',
  secondary_bg_color: '#1a222c',
  header_bg_color: '#10161d',
  accent_text_color: '#6ab3f3',
  section_bg_color: '#212b37',
  section_header_text_color: '#7fb3e8',
  subtitle_text_color: '#8c99a6',
  destructive_text_color: '#ff6b62',
  section_separator_color: '#26313e',
  bottom_bar_bg_color: '#0c1218',
} as const;

function prefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

function mockInitData(): URLSearchParams {
  const user = {
    id: 99281,
    first_name: 'Гость',
    last_name: '',
    username: 'devuser',
    language_code: 'ru',
    is_premium: false,
    allows_write_to_pm: true,
  };
  // `hash` + `signature` are required by the Bot API 8.x init-data schema; the
  // mock never validates them (real validation is on the backend).
  return new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    hash: 'mockhash',
    signature: 'mocksignature',
    user: JSON.stringify(user),
  });
}

function emit(eventType: string, eventData: unknown): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ eventType, eventData }),
      source: window.parent,
    }),
  );
}

function installMock(): void {
  const insets = { left: 0, top: 0, right: 0, bottom: 0 };
  const theme = prefersDark() ? DARK_THEME : LIGHT_THEME;
  mockTelegramEnv({
    launchParams: {
      tgWebAppData: mockInitData(),
      tgWebAppVersion: '8.0',
      tgWebAppPlatform: 'tdesktop',
      tgWebAppThemeParams: theme,
    },
    onEvent(event, next) {
      const [name] = event;
      switch (name) {
        case 'web_app_request_theme':
          emit('theme_changed', { theme_params: theme });
          return;
        case 'web_app_request_viewport':
          emit('viewport_changed', {
            height: window.innerHeight,
            width: window.innerWidth,
            is_expanded: true,
            is_state_stable: true,
          });
          return;
        case 'web_app_request_content_safe_area':
          emit('content_safe_area_changed', insets);
          return;
        case 'web_app_request_safe_area':
          emit('safe_area_changed', insets);
          return;
        default:
          next();
      }
    },
  });
}

/**
 * Push the current `--kj-bottom-bar-bg` to Telegram via setBottomBarColor
 * (Bot API 7.10+). On Android this also tints the system navigation bar. No-op
 * in the browser mock / older clients.
 */
export function syncBottomBarColor(): void {
  try {
    const color = getComputedStyle(document.documentElement).getPropertyValue('--kj-bottom-bar-bg').trim();
    if (!color) return;
    const setter = (miniApp as unknown as {
      setBottomBarColor?: { (c: string): void; isAvailable(): boolean };
    }).setBottomBarColor;
    if (setter && typeof setter.isAvailable === 'function' && setter.isAvailable()) {
      setter(color);
    }
  } catch {
    /* method unsupported / invalid color — ignore */
  }
}

/**
 * Match Telegram's native header + background to our own base bg (`--kj-bg`), so
 * the native chrome follows the app's (now dark-by-default) palette instead of
 * the client's own light/dark theme. Arbitrary-hex header colours are Bot API
 * 6.9+, background 6.1+. Guarded by isAvailable()/supports() + try/catch, so
 * older clients and the browser mock are a silent no-op.
 */
export function syncChromeColor(): void {
  try {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--kj-bg').trim();
    if (!bg) return;
    const app = miniApp as unknown as {
      setHeaderColor?: { (c: string): void; isAvailable(): boolean; supports?(k: string): boolean };
      setBackgroundColor?: { (c: string): void; isAvailable(): boolean };
    };
    const header = app.setHeaderColor;
    if (header && typeof header.isAvailable === 'function' && header.isAvailable()) {
      // Some clients only accept the 'bg_color'/'secondary_bg_color' keys; only
      // push a raw hex where the client reports it supports arbitrary colours.
      if (typeof header.supports !== 'function' || header.supports('color')) header(bg);
    }
    const background = app.setBackgroundColor;
    if (background && typeof background.isAvailable === 'function' && background.isAvailable()) {
      background(bg);
    }
  } catch {
    /* method unsupported / invalid color — ignore */
  }
}

function readLaunch(): RetrieveLPResult | undefined {
  try {
    return retrieveLaunchParams();
  } catch {
    return undefined;
  }
}

function mountSafe(fn: { (): unknown; isAvailable?: () => boolean }): void {
  try {
    if (!fn.isAvailable || fn.isAvailable()) fn();
  } catch {
    /* scope unsupported in this environment — graceful degradation */
  }
}

/** Bootstrap the SDK/mock and return the launch context. Never throws. */
export function bootstrapTelegram(): LaunchContext {
  const real = isTMA();
  if (!real) installMock();

  try {
    init();
  } catch {
    /* keep the app usable in a degraded mode */
  }

  mountSafe(backButton.mount);
  mountSafe(mainButton.mount);
  mountSafe(secondaryButton.mount);
  mountSafe(themeParams.mount);
  mountSafe(miniApp.mountSync);
  try {
    initData.restore();
  } catch {
    /* no-op */
  }
  try {
    if (viewport.mount.isAvailable()) {
      viewport
        .mount()
        .then(() => mountSafe(viewport.bindCssVars))
        .catch(() => {
          /* viewport unavailable — ignore */
        });
    }
  } catch {
    /* no-op */
  }

  const lp = readLaunch();
  return {
    languageCode: lp?.tgWebAppData?.user?.language_code,
    username: lp?.tgWebAppData?.user?.username,
    isReal: real,
  };
}
