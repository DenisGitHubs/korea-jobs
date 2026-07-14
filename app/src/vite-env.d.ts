/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'mock' runs the UI without a backend (browser dev). Anything else = live. */
  readonly VITE_API_MODE?: string;
  /** Real API base. Empty = same-origin `/api`. */
  readonly VITE_API_BASE_URL?: string;
  /** Dev-only raw initData string so `Authorization: tma …` works outside Telegram. */
  readonly VITE_TEST_INITDATA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
