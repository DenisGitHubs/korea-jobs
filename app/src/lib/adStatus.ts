import type { TFunction } from 'i18next';
import type { UserAdStatus } from '../shared/types/api';

/**
 * Visual/behavioural class of a "My ads" status chip. The UI maps `kind` to a
 * colour; `label` is the ready localized text.
 */
export type AdStatusKind =
  | 'fresh'
  | 'aged'
  | 'archived'
  | 'pending'
  | 'rejected'
  | 'expired'
  | 'takendown';

export interface AdStatusInfo {
  label: string;
  kind: AdStatusKind;
}

const HOUR_MS = 3_600_000;
/** Below this many hours since the freshness base an approved ad reads "Fresh". */
export const FRESH_HOURS = 12;

/**
 * Freshness base timestamp (ms) of an ad = max(created_at, bumped_at). A bump
 * moves this forward so a bumped ad reads as "Fresh" again.
 */
export function freshnessBaseMs(createdAt: string, bumpedAt: string | null): number {
  const c = new Date(createdAt).getTime();
  const cc = Number.isNaN(c) ? 0 : c;
  if (!bumpedAt) return cc;
  const b = new Date(bumpedAt).getTime();
  return Number.isNaN(b) ? cc : Math.max(cc, b);
}

/**
 * Pure status resolver for a user ad. `now` (ms) and the translator `t` are
 * injected — the function calls no clock and no global, so it is fully testable.
 *
 * approved: < FRESH_HOURS from the freshness base → "Fresh"; otherwise "N h"
 * (whole hours). Other statuses map to their own label/kind.
 */
export function adStatusInfo(
  status: UserAdStatus,
  createdAt: string,
  bumpedAt: string | null,
  now: number,
  t: TFunction,
): AdStatusInfo {
  switch (status) {
    case 'archived':
      return { label: t('myAds.status.archived'), kind: 'archived' };
    case 'pending':
    case 'draft':
      return { label: t('myAds.status.pending'), kind: 'pending' };
    case 'rejected':
      return { label: t('myAds.status.rejected'), kind: 'rejected' };
    case 'expired':
      return { label: t('myAds.status.expired'), kind: 'expired' };
    case 'taken_down':
      return { label: t('myAds.status.takenDown'), kind: 'takendown' };
    case 'approved': {
      const hours = Math.floor((now - freshnessBaseMs(createdAt, bumpedAt)) / HOUR_MS);
      if (hours < FRESH_HOURS) return { label: t('myAds.status.fresh'), kind: 'fresh' };
      return { label: t('myAds.status.hours', { count: hours }), kind: 'aged' };
    }
    default:
      return { label: t('myAds.status.pending'), kind: 'pending' };
  }
}
