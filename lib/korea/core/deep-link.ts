// lib/korea/core/deep-link.ts
//
// Single source of truth for building a Mini App deep link
// `https://t.me/<bot>/<app>?startapp=<param>`. The bot username + app short-name come from
// config (`referral_bot_username` / `referral_app_shortname`) or the matching env vars — the
// SAME authoritative source the referral link uses, so the referral link and the vacancy
// share button can never drift on which bot / short-name they point at.
//
// When the bot + short-name are not configured yet it falls back to APP_URL with the code as a
// `startapp` query. That URL is NOT a proper t.me deep link, so the share flow will not
// auto-open the Mini App — set the config/env once the bot + short-name are final (this is
// intentional and flagged rather than hardcoding a bot name here).

import { getConfigString } from '../config.js';

/** Build the canonical Mini App deep link for a `startapp` payload. */
export async function buildMiniAppDeepLink(startParam: string): Promise<string> {
  const bot = process.env.REFERRAL_BOT_USERNAME || (await getConfigString('referral_bot_username', ''));
  const app = process.env.REFERRAL_APP_SHORTNAME || (await getConfigString('referral_app_shortname', ''));
  const sp = encodeURIComponent(startParam);
  if (bot && app) {
    return `https://t.me/${bot}/${app}?startapp=${sp}`;
  }
  const appUrl = process.env.APP_URL ?? '';
  const sep = appUrl.includes('?') ? '&' : '?';
  return appUrl ? `${appUrl}${sep}startapp=${sp}` : `?startapp=${sp}`;
}
