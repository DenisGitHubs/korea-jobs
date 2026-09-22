/**
 * Auth header for every API request. TWO ways in, in this order:
 *   `Authorization: kjs <pass>`      — our own session pass, issued by
 *                                      POST /api/auth/hub after the AppHub
 *                                      Studio shell handed us its ticket;
 *   `Authorization: tma <initData>`  — Telegram, exactly as before.
 *
 * The pass goes first because inside the shell there is no Telegram client and
 * the SDK has nothing to give. Inside Telegram there is no pass, so the tma
 * path stays untouched, byte for byte. An expired pass is dropped, not sent.
 */
import { retrieveRawInitData } from '@telegram-apps/sdk-react';
import { readLiveHubPass } from '../../lib/hubTicket';

export function authHeader(): Record<string, string> {
  // Shell hand-off: our own pass, while it is still valid (readLiveHubPass
  // clears an expired one itself).
  const pass = readLiveHubPass();
  if (pass) return { Authorization: `kjs ${pass.token}` };

  // Inside a real Telegram client: the SDK gives us the raw initData string.
  try {
    const raw = retrieveRawInitData();
    if (raw) return { Authorization: `tma ${raw}` };
  } catch {
    /* not launched from Telegram — fall through to the dev fallback */
  }

  // Dev fallback (plain browser): a raw initData string supplied via env so the
  // live API can still be exercised outside Telegram. Never a secret.
  const test = import.meta.env.VITE_TEST_INITDATA;
  if (test) return { Authorization: `tma ${test}` };

  return {};
}
