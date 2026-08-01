/**
 * The two new optional listing properties — the paid-placement flag and the
 * cover image — read through ONE place, so every surface (feed preview, open
 * card, anything added later) treats them identically.
 */
import type { VacancyView } from '../shared/types/api';

/**
 * Alternative spellings the backend might ship the paid-placement flag under.
 * The «Реклама» label is legally MANDATORY on every surface that shows a paid
 * listing, so a naming mismatch must never silently drop it — we accept the
 * agreed `promo` first and tolerate the obvious synonyms. Absent === false.
 */
type PromoShape = Partial<Pick<VacancyView, 'promo'>> & {
  is_promo?: boolean;
  is_ad?: boolean;
};

/** True when the listing is a paid placement and must be labeled «Реклама». */
export function isPromo(v: VacancyView | null | undefined): boolean {
  if (!v) return false;
  const p = v as PromoShape;
  return p.promo === true || p.is_promo === true || p.is_ad === true;
}

/**
 * Absolute src for a listing image. The backend sends a path rooted at the API
 * (`/api/media/<uuid>`); that resolves correctly against the app origin in the
 * normal same-origin deploy. When VITE_API_BASE_URL points the API at another
 * ORIGIN, a bare path would hit the app instead — so we re-root it there.
 * NOTE: a cross-origin media host also needs `img-src` widened in the CSP
 * (vercel.json currently allows `'self' data: blob:`), which is a deploy-side
 * change, not a client one.
 * Returns null for an absent/blank value so callers can render "no image".
 */
export function mediaSrc(url: string | null | undefined): string | null {
  const raw = (url ?? '').trim();
  if (!raw) return null;
  // Already absolute (or a data:/blob: URI) → use as-is.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return raw;
  const base = import.meta.env.VITE_API_BASE_URL;
  if (base && /^https?:\/\//i.test(base)) {
    try {
      return new URL(raw, new URL(base).origin).toString();
    } catch {
      /* malformed base → fall through to the plain path */
    }
  }
  return raw;
}
