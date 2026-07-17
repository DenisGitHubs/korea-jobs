/**
 * Enum -> i18n key + presentation helpers. Kept in one place so screens never
 * hardcode label strings and the ordering is consistent everywhere.
 */
import type { ContactKind, Gender, PlacementFee, SalaryPeriod, VisaType, WorkType } from './types/api';

export const WORK_TYPES: readonly WorkType[] = [
  'factory',
  'construction',
  'agriculture',
  'fishery',
  'food',
  'logistics',
  'restaurant',
  'cleaning',
  'caregiving',
  'hotel',
  'services',
  'other',
] as const;

export const GENDERS: readonly Gender[] = ['any', 'male', 'female', 'couple'] as const;

/** Visas usable as filter chips / ad options ('any' = no restriction, omitted here).
    Order follows the visa reference (_docs/research/korea-visas-and-scams.md §1). */
export const VISA_TYPES: readonly VisaType[] = [
  'f4',
  'h2',
  'e9',
  'e8',
  'e7',
  'f6',
  'f_series',
  'd10',
  'd_series',
  'g1',
  'tourist',
  'other',
] as const;

export const CONTACT_KINDS: readonly ContactKind[] = [
  'phone',
  'telegram',
  'kakao',
  'whatsapp',
  'other',
] as const;

/** Placement-fee options offered in the ad wizard. */
export const PLACEMENT_FEES: readonly PlacementFee[] = ['free', 'paid', 'unknown'] as const;

/** Freshness windows (days) for the feed filter. */
export const FRESHNESS_DAYS: readonly (1 | 3 | 7 | 14)[] = [1, 3, 7, 14] as const;

/** i18n keys. */
export const workTypeKey = (w: WorkType): string => `work.${w}`;
export const genderKey = (g: Gender): string => `gender.${g}`;
export const periodKey = (p: SalaryPeriod): string => `period.${p}`;
export const regionKey = (slug: string): string => `region.${slug}`;
export const visaKey = (v: VisaType): string => `visa.${v}`;
export const feeKey = (f: PlacementFee): string => `fee.${f}`;
export const contactKindKey = (k: ContactKind): string => `contactKind.${k}`;
export const freshnessKey = (d: 1 | 3 | 7 | 14): string => `freshness.d${d}`;

/** Small glyph per work type for the feed/card badges (product UI, not chrome). */
export const WORK_TYPE_EMOJI: Record<WorkType, string> = {
  factory: '🏭',
  construction: '🏗️',
  agriculture: '🌾',
  fishery: '🐟',
  food: '🍱',
  logistics: '📦',
  restaurant: '🍜',
  cleaning: '🧹',
  caregiving: '🧑‍⚕️',
  hotel: '🏨',
  services: '🛠️',
  other: '💼',
};
