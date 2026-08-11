/**
 * "Are we OUTSIDE Telegram?" — one conservative check, evaluated once at boot.
 *
 * Why it exists: opened in a plain browser the mini app has no initData, so
 * GET /me answers 401, the consent gate stays up (fail-closed) and an error
 * strip shows underneath. A stranger — or an ad moderator — reads that as "the
 * destination site returns an error". Outside Telegram we therefore render a
 * static landing page instead of the app (components/OutsideTelegram.tsx).
 *
 * The check is deliberately ASYMMETRIC. A wrong "outside" would hide the whole
 * app from a real user; a wrong "inside" only keeps today's behaviour. So it
 * returns true ONLY when EVERY Telegram trait is absent, and any unexpected
 * throw resolves to "inside".
 *
 * ORDER MATTERS: call this BEFORE bootstrapTelegram(). Outside a real client
 * that helper installs a mock Telegram env (mockTelegramEnv), after which
 * isTMA() and retrieveLaunchParams() answer "yes" for everyone. Calling it
 * later can only ever return false — the safe direction, never a false landing.
 */
import { isTMA, retrieveLaunchParams } from '@telegram-apps/sdk-react';
import { USE_MOCK } from '../shared/api/client';

/** sessionStorage key the SDK caches the launch params under (`tapps/` prefix). */
const LP_STORAGE_KEY = 'tapps/launchParams';

/** The primary signal: the host handed us launch parameters. */
function hasLaunchParams(): boolean {
  try {
    if (isTMA()) return true;
  } catch {
    return true; // unexpected — assume Telegram
  }
  try {
    const lp = retrieveLaunchParams() as Record<string, unknown> | undefined;
    if (lp && Object.keys(lp).length > 0) return true;
  } catch {
    /* no launch params in this environment — keep probing */
  }
  return false;
}

/** `#tgWebAppData=…` in the URL now, in the original navigation URL, or cached. */
function hasLaunchTrace(): boolean {
  try {
    if (`${window.location.hash}${window.location.search}`.includes('tgWebApp')) return true;
    const nav = performance.getEntriesByType('navigation')[0] as { name?: string } | undefined;
    if (nav?.name?.includes('tgWebApp')) return true;
    if (sessionStorage.getItem(LP_STORAGE_KEY)) return true;
  } catch {
    return true; // storage/perf blocked — do not guess "outside"
  }
  return false;
}

/** Native client bridges injected by the Telegram WebView (all platforms). */
function hasClientBridge(): boolean {
  try {
    const w = window as unknown as {
      TelegramWebviewProxy?: unknown;
      TelegramWebviewProxyProto?: unknown;
      TelegramWebview?: unknown;
      Telegram?: { WebApp?: unknown };
      external?: { notify?: unknown };
    };
    if (w.TelegramWebviewProxy || w.TelegramWebviewProxyProto || w.TelegramWebview) return true;
    if (w.Telegram?.WebApp) return true;
    if (typeof w.external?.notify === 'function') return true;
  } catch {
    return true;
  }
  return false;
}

/**
 * Telegram Web (K/Z) runs mini apps in an iframe — and our CSP allows
 * `frame-ancestors` only for telegram.org / t.me, so being embedded at all
 * means being embedded by Telegram. A cross-origin parent throws on access;
 * that throw is itself proof we are framed.
 */
function isEmbedded(): boolean {
  try {
    return window.parent !== window || window.top !== window;
  } catch {
    return true;
  }
}

/**
 * NOT a signal: `document.referrer`. It was tried and deliberately dropped (007,
 * 07.08.2026). A referrer only says where the click came FROM, never where the
 * page is running — and the two cases it fires on are exactly the ones this
 * whole file exists to fix:
 *   * an ad moderator opening the destination from ads.telegram.org,
 *   * anyone tapping our link inside Telegram's in-app browser (not a mini app).
 * Both arrive with a telegram referrer in a PLAIN browser: no initData, GET /me
 * 401, consent gate up, error strip underneath — the "destination returns an
 * error" that got the ad rejected. Reading that as "inside Telegram" would show
 * them the broken app instead of the landing page. It is also the one signal any
 * third-party site can forge. The four traits below are properties of the
 * runtime itself and cannot be faked into hiding the app from a real user.
 */

/**
 * True only for a plain browser with no trace of Telegram whatsoever.
 * Mock mode and the dev initData harness are never "outside": browser preview
 * must keep running the full app exactly as before.
 */
export function isOutsideTelegram(): boolean {
  try {
    if (USE_MOCK) return false;
    if (import.meta.env.VITE_TEST_INITDATA) return false;
    return !(hasLaunchParams() || hasLaunchTrace() || hasClientBridge() || isEmbedded());
  } catch {
    return false;
  }
}
