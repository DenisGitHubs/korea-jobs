/**
 * Contact-string helpers. `contact_raw` (vacancies & user ads) is ONE text field
 * that may pack SEVERAL contacts joined by ' · ' (U+00B7 middle dot, padded with
 * spaces — the exact separator the composer/back-end emit). Each part looks like
 * "[name ]value[ (langs/notes)]"; the UI renders one row per part.
 */

/** Separator the back-end/composer use to join multiple contacts into one field. */
export const CONTACT_SEP = ' · ';

/** Split a contact field into individual, trimmed, non-empty contacts. */
export function splitContacts(value: string): string[] {
  return value
    .split(CONTACT_SEP)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Find a Telegram username inside a free-form contact part
 * (@nick, t.me/nick, https://t.me/nick, tg://resolve?domain=nick).
 * Returns the bare username or null. Free search — a strict superset of the old
 * anchored matcher, so it also picks up handles mid-string ("пишите в тг @nick").
 */
export function findTelegramUsername(part: string): string | null {
  const link = part.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{3,32})/i);
  if (link) return link[1];
  const domain = part.match(/tg:\/\/resolve\?domain=([A-Za-z0-9_]{3,32})/i);
  if (domain) return domain[1];
  const at = part.match(/(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_]{3,32})/);
  return at ? at[1] : null;
}

/**
 * Extract a dial-able phone (>=7 digits, allowing spaces/dashes/parens and a
 * leading '+') from a free-form contact part. Returns the tel: value (digits with
 * an optional leading '+') or null when no phone-like run is present.
 */
export function findPhone(part: string): string | null {
  const m = part.match(/\+?\d[\d\s().-]{5,}\d/);
  if (!m) return null;
  const kept = m[0].replace(/[^\d+]/g, '');
  const plus = kept.startsWith('+') ? '+' : '';
  const digits = kept.replace(/\D/g, '');
  return digits.length >= 7 ? `${plus}${digits}` : null;
}
