/**
 * Auth header for every API request: `Authorization: tma <raw initData>`.
 * The backend validates the initData signature (HMAC). We only forward the raw
 * string exactly as Telegram provided it.
 */
import { retrieveRawInitData } from '@telegram-apps/sdk-react';

export function authHeader(): Record<string, string> {
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
