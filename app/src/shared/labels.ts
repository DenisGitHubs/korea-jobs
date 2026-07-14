/**
 * Enum -> i18n key + presentation helpers. Kept in one place so screens never
 * hardcode label strings and the ordering is consistent everywhere.
 */
import type { Gender, SalaryPeriod, WorkType } from './types/api';

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

/** i18n keys. */
export const workTypeKey = (w: WorkType): string => `work.${w}`;
export const genderKey = (g: Gender): string => `gender.${g}`;
export const periodKey = (p: SalaryPeriod): string => `period.${p}`;
export const regionKey = (slug: string): string => `region.${slug}`;

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
