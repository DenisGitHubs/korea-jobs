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
  /** True inside a real Telegram client (not the browser mock). */
  isReal: boolean;
}

// Telegram theme params (snake_case keys, exactly as a real client sends them).
const LIGHT_THEME = {
  bg_color: '#ffffff',
  text_color: '#0f0f10',
  hint_color: '#8e8e93',
  link_color: '#2481cc',
  button_color: '#2481cc',
  button_text_color: '#ffffff',
  secondary_bg_color: '#efeff4',
  header_bg_color: '#ffffff',
  accent_text_color: '#2481cc',
  section_bg_color: '#ffffff',
  section_header_text_color: '#6d6d72',
  subtitle_text_color: '#8e8e93',
  destructive_text_color: '#ff3b30',
  section_separator_color: '#e6e6ea',
  bottom_bar_bg_color: '#f7f7f9',
} as const;

const DARK_THEME = {
  bg_color: '#17212b',
  text_color: '#f5f5f5',
  hint_color: '#7d8b99',
  link_color: '#6ab3f3',
  button_color: '#5288c1',
  button_text_color: '#ffffff',
  secondary_bg_color: '#232e3c',
  header_bg_color: '#17212b',
  accent_text_color: '#6ab3f3',
  section_bg_color: '#1d2733',
  section_header_text_color: '#6ab3f3',
  subtitle_text_color: '#7d8b99',
  destructive_text_color: '#ec3942',
  section_separator_color: '#101921',
  bottom_bar_bg_color: '#151e27',
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
    isReal: real,
  };
}
