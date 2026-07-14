/**
 * API contract types (frontend view models).
 * Mirrors the backend projection described in the task brief. NOTE: the feed
 * NEVER carries `contact` — it is revealed only on explicit user action in the
 * card, via a dedicated endpoint (anti-harvesting of employers' phones).
 */

export type WorkType =
  | 'factory'
  | 'construction'
  | 'agriculture'
  | 'fishery'
  | 'food'
  | 'logistics'
  | 'restaurant'
  | 'cleaning'
  | 'caregiving'
  | 'hotel'
  | 'services'
  | 'other';

export type Gender = 'any' | 'male' | 'female' | 'couple';

export type SalaryPeriod = 'hour' | 'day' | 'shift' | 'month' | 'piece';

export type ContactKind = 'phone' | 'telegram' | 'kakao' | 'whatsapp' | 'other';

/** Localized display text as stored in the DB (jsonb { ru, ko, en }). */
export interface Localized {
  ru: string;
  ko: string;
  en: string;
}

export interface City {
  slug: string;
  name: Localized;
  region_slug: string | null;
}

export interface VacancyContact {
  kind: ContactKind;
  value: string;
}

export interface VacancyView {
  id: string;
  city: { slug: string; name: Localized } | null;
  region_slug: string | null;
  work_type: WorkType;
  gender: Gender;
  salary_text: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_period: SalaryPeriod | null;
  employer: string | null;
  description: string;
  /** ISO 8601 timestamp. */
  posted_at: string;
  has_contact: boolean;
  /** Present only on the detail/reveal endpoint, never in the feed. */
  contact?: VacancyContact;
}

/** Cursor page. `next_cursor === null` means no more items. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface Subscription {
  city_slugs: string[];
  work_types: string[];
  notify: boolean;
}

export interface Me {
  public_id: string;
  lang: string;
  subscription: Subscription;
}

/** Filters passed to GET /vacancies. */
export interface VacancyQuery {
  cities?: string[];
  work_types?: WorkType[];
  cursor?: string;
}
