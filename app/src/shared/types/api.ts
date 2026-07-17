/**
 * API contract types (frontend view models).
 * Mirrors the backend projection (lib/korea/**). NOTE: the feed NEVER carries
 * `contact` — it is revealed only on explicit user action in the card, via a
 * dedicated endpoint (anti-harvesting of employers' phones).
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

/**
 * Visa the offer accepts. 'any' = no restriction. F/D families are split:
 * f4/f6 are called out separately, f_series = F-2/F-5, d_series = D-2/D-4.
 */
export type VisaType =
  | 'any'
  | 'f4'
  | 'e9'
  | 'e7'
  | 'e8'
  | 'h2'
  | 'f6'
  | 'f_series'
  | 'd10'
  | 'd_series'
  | 'g1'
  | 'tourist'
  | 'other';

/** Whether a placement/agency fee is charged. 'unknown' = not stated. */
export type PlacementFee = 'free' | 'paid' | 'unknown';

/** Where a feed item comes from. */
export type SourceKind = 'scraped' | 'user';

/** Lifecycle of a user-submitted ad. */
export type UserAdStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'taken_down' | 'expired';

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
  /** ISO 8601 timestamp (a user ad's is its created_at). */
  posted_at: string;
  has_contact: boolean;
  /** Accepted visas; empty = not stated. */
  visa_types: VisaType[];
  placement_fee: PlacementFee;
  /** Three-state: true=provided, false=explicitly none, null=not stated. */
  has_housing: boolean | null;
  has_meals: boolean | null;
  /** 'scraped' (from a channel) or 'user' (a submitted ad). */
  source_kind: SourceKind;
  /** true when this offer was seen again (repost_count > 0) — "Повторное" badge. */
  repost: boolean;
  /** Whether the current user has bookmarked this offer (present in all projections). */
  is_saved: boolean;
  /** Present only on the detail/reveal endpoint, never in the feed. */
  contact?: VacancyContact;
}

/**
 * GET /api/raw item — a listing the AI could not structure into a VacancyView.
 * Contacts are scrubbed server-side; shown read-only with an "unverified" signal.
 */
export interface RawView {
  id: string;
  /** Scrubbed message text (contacts removed). */
  text: string;
  /** May be null when the source timestamp is unreliable. */
  posted_at: string | null;
  /** Coarse age in days, for display (used when posted_at is missing/unreliable). */
  age_hint: number;
  status_hint: 'unverified';
  source_kind: 'raw';
}

/** Cursor page. `next_cursor === null` means no more items. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** Filters passed to GET /api/vacancies (all optional; permissive matching). */
export interface VacancyQuery {
  /** city slugs */
  cities?: string[];
  work_types?: WorkType[];
  /** province/region slugs (cities.region_slug) */
  regions?: string[];
  visa?: VisaType[];
  /** 'free' | 'paid'; omit for both */
  paid?: 'free' | 'paid';
  /** only offers with housing (or unstated) */
  housing?: boolean;
  /** only offers with meals (or unstated) */
  meals?: boolean;
  /** free-text search (websearch syntax; server strips '.') */
  q?: string;
  /** posted within the last N days */
  freshness?: 1 | 3 | 7 | 14;
  cursor?: string;
}

export interface Subscription {
  city_slugs: string[];
  work_types: string[];
  notify: boolean;
  /** Persistent visa filter; empty = all. */
  visa_types: VisaType[];
  /** Persistent fee filter; null = all. */
  placement_fee: PlacementFee | null;
  /** true = require housing (or unstated); null/false = no filter. */
  require_housing: boolean | null;
  require_meals: boolean | null;
}

export interface TermsState {
  /** true when the user must (re-)accept before restricted actions. */
  required: boolean;
  version: string;
}

export interface Me {
  public_id: string;
  lang: string;
  terms: TermsState;
  subscription: Subscription;
  /** Loyalty points balance (referral program). */
  points_total: number;
  /** First-run onboarding completed (server-persisted, so it never repeats cross-device). */
  onboarded: boolean;
}

/** One referral tier's counters (invited people + points earned from them). */
export interface ReferralLevelStat {
  level: number;
  invited: number;
  points: number;
}

/**
 * GET /api/referral — the invite screen's data. `code`/`link` are minted by the
 * backend (canonical Mini App deep link); scope is always derived server-side
 * from the authenticated user, never from the request body.
 */
export interface ReferralView {
  code: string;
  link: string;
  /** Confirmed loyalty balance (истина = confirmed ledger rows). */
  points_total: number;
  /** Points awaiting confirmation (anti-fraud delay); not yet spendable. */
  points_pending: number;
  /** Exactly three tiers, L1→L3. */
  levels: ReferralLevelStat[];
}

/** POST /api/terms/accept response. */
export interface TermsAcceptResult {
  ok: true;
  version: string;
}

/** Body for POST /api/ads. Only title, description, contact_raw are required. */
export interface AdInput {
  city_slug?: string | null;
  region_slug?: string | null;
  work_type?: WorkType;
  visa_types?: VisaType[];
  placement_fee?: PlacementFee;
  has_housing?: boolean | null;
  has_meals?: boolean | null;
  salary_text?: string | null;
  title: string;
  description: string;
  contact_raw: string;
  contact_kind?: ContactKind;
  housing_terms?: string | null;
  meals_info?: string | null;
  schedule?: string | null;
}

/** POST /api/ads response. */
export interface AdCreateResult {
  id: string | null;
  status: 'approved' | 'pending' | 'rejected';
}

/** An item of GET /api/ads/mine. */
export interface UserAd {
  id: string;
  city: { slug: string; name: Localized } | null;
  region_slug: string | null;
  work_type: WorkType;
  visa_types: VisaType[];
  placement_fee: PlacementFee;
  has_housing: boolean | null;
  has_meals: boolean | null;
  salary_text: string | null;
  title: string;
  description: string;
  contact_raw: string | null;
  contact_kind: ContactKind | null;
  housing_terms: string | null;
  meals_info: string | null;
  schedule: string | null;
  status: UserAdStatus;
  reject_reason: string | null;
  created_at: string;
  expires_at: string | null;
}

/** Body for POST /api/cooperation (stub: at least one of the two). */
export interface CooperationInput {
  contact?: string;
  message?: string;
}

/** Body for POST /api/vacancies/:id/report. */
export interface ReportInput {
  reason?: string;
}

/** Generic success envelope: POST /api/vacancies/:id/report, POST /api/cooperation. */
export interface OkResult {
  ok: true;
}

/** GET /api/stats — feed-wide totals for the aggregator bar. */
export interface Stats {
  vacancies_count: number;
  sources_count: number;
}
