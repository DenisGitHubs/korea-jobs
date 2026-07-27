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

/**
 * Lifecycle of a user-submitted ad. 'archived' is a user-triggered state (the
 * author parks an ad off the feed; it can later be sent back through moderation).
 */
export type UserAdStatus =
  | 'draft'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'taken_down'
  | 'expired'
  | 'archived';

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

/**
 * GET /vacancies/:id/contact — the reveal endpoint response. `contact` is null when
 * the listing has no direct contact. `reveals_left` is the user's remaining daily
 * reveal budget AFTER this call; optional so a backend that has not shipped the field
 * yet degrades gracefully (the client just keeps its previous counter / hides the hint).
 */
export interface VacancyContactReveal {
  contact: VacancyContact | null;
  reveals_left?: number;
}

export interface VacancyView {
  id: string;
  city: { slug: string; name: Localized } | null;
  /**
   * All cities of the offer (multi-city listings). The FIRST element is the main
   * city (the one behind `city`/`city_id`); the rest follow deterministically by
   * slug. Empty array = city not specified. `city` is kept for backward compat.
   * Optional so a real backend that has not shipped the field yet degrades to
   * `[city]` on the client.
   */
  cities?: Array<{ slug: string; name: Localized }>;
  /**
   * Region (province/metro) slugs this offer belongs to: the regions of its cities
   * ∪ regions detected in the text/hint. The card/screen shows "<Region> · region"
   * when `cities` is empty but a region is known. Optional so a backend that has
   * not shipped the field yet degrades gracefully (no region label).
   */
  regions?: string[];
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
  /**
   * Whether the current user has already revealed this offer's contact before
   * (present in all projections). A repeat reveal is free — the backend serves
   * the contact again without charging the daily budget.
   */
  is_revealed: boolean;
  /** Present only on the detail/reveal endpoint, never in the feed. */
  contact?: VacancyContact;
  /**
   * Ready-made link to the original post in the source channel
   * (`https://t.me/<channel>/<post_id>`). Present when the source channel has a
   * public username AND the listing either has NO direct contact OR its city is
   * unresolved (so the location can be clarified in the original); otherwise null.
   */
  source_post_url?: string | null;
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

/**
 * POST /api/raw/reveal — the ORIGINAL (unfiltered) text of an unverified listing,
 * with the contact inline in free form. Revealed only on explicit user action and
 * subject to the shared daily reveal limit (same budget as vacancy contacts).
 */
export interface RawRevealView {
  id: string;
  /** Original message text; the contact is somewhere inside it, unstructured. */
  text: string;
  /**
   * Remaining daily reveal budget AFTER this call (shared with vacancy contacts).
   * Optional — absent on a backend that has not shipped the field yet.
   */
  reveals_left?: number;
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
  /**
   * Whether to also include offers with NO city ("city not specified").
   * Acts ONLY when at least one city is selected; with an empty city list the
   * whole feed is shown and this flag is ignored. Absent === true (included).
   */
  no_city?: boolean;
  cursor?: string;
}

export interface Subscription {
  city_slugs: string[];
  /** Region (province) slugs to also match; empty = none. Default []. */
  region_slugs?: string[];
  work_types: string[];
  notify: boolean;
  /** Persistent visa filter; empty = all. */
  visa_types: VisaType[];
  /** Persistent fee filter; null = all. */
  placement_fee: PlacementFee | null;
  /** true = require housing (or unstated); null/false = no filter. */
  require_housing: boolean | null;
  require_meals: boolean | null;
  /**
   * Daily digest opt-in (bot sends one summary message a day). OPT-IN: an absent
   * flag means "off" — always send it explicitly when saving a subscription.
   */
  digest_enabled?: boolean;
  /**
   * How many realtime job MESSAGES (DMs) the bot may send per day, counted in
   * Seoul time. A number = the cap (one message can carry several offers);
   * `null` = no limit. OPTIONAL for backward compat: an ABSENT field means the
   * backend has not shipped the cap yet and must be read as "no limit" (exactly
   * today's behaviour) — never as a silently imposed limit. POST /subscription
   * REPLACES the whole row, so the client always sends the field once it knows a
   * value.
   */
  notify_daily_cap?: number | null;
  /**
   * Also notify about / show offers with no city when the city filter is set.
   * Defaults to true (optional so older payloads default to "included").
   */
  no_city?: boolean;
}

export interface TermsState {
  /** true when the user must (re-)accept before restricted actions. */
  required: boolean;
  version: string;
}

/**
 * Server-side feature switches carried by GET /api/me. Additive and OPTIONAL:
 * an absent object (or an absent key) always means "off", so an older backend
 * degrades to today's behaviour.
 */
export interface MeFlags {
  /**
   * true = the "⚠ Не разобрано" (raw) feed segment is switched off for everyone.
   * The server already serves an empty /api/raw and 404s /api/raw/reveal; the
   * client must additionally not render the tab at all (an empty tab looks broken).
   */
  hide_unverified?: boolean;
}

export interface Me {
  public_id: string;
  lang: string;
  terms: TermsState;
  subscription: Subscription;
  /** Additive server switches; absent === everything off. */
  flags?: MeFlags;
  /**
   * Convenience MIRROR of `subscription.notify_daily_cap` (number = cap on daily
   * job DMs, null = no limit). The source of truth is the field inside
   * `subscription`; this one is only read when the subscription omits it, so a
   * backend that surfaces the cap at the top level still works.
   */
  notify_daily_cap?: number | null;
  /** Loyalty points balance (referral program). */
  points_total: number;
  /** First-run onboarding completed (server-persisted, so it never repeats cross-device). */
  onboarded: boolean;
  /**
   * How many contact reveals the user has left today (out of the shared daily
   * budget). Optional so a backend that has not shipped the field yet degrades
   * gracefully — the client hides the "reveals left" hint when it is absent.
   */
  reveals_left?: number;
}

/** One referral tier's counters (invited people + points earned from them). */
export interface ReferralLevelStat {
  level: number;
  invited: number;
  points: number;
}

/**
 * One daily streak (visit or open). `bonus` points are granted every `bonus_every`
 * consecutive days; `len` is the current run length. Amounts come from the server
 * (config-driven) — never hardcode them in the UI.
 */
export interface StreakStat {
  len: number;
  bonus: number;
  bonus_every: number;
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
  /** Daily engagement streaks + their 7-day bonuses (server-driven amounts). */
  streaks: { visit: StreakStat; open: StreakStat };
}

/** POST /api/terms/accept response. */
export interface TermsAcceptResult {
  ok: true;
  version: string;
}

/** Body for POST /api/ads. Only title, description, contact_raw are required. */
export interface AdInput {
  city_slug?: string | null;
  /** Free-text city when it is not in the seed list ("Other"); server trims to <=60. */
  city_text?: string | null;
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
  /** Free-text city ("Other") when `city` is null; null when a seed city was chosen. */
  city_text: string | null;
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
  /** Last "bump" (freshness refresh); null if never bumped. Freshness base = max(created_at, bumped_at). */
  bumped_at: string | null;
  expires_at: string | null;
}

/** Alias for the GET /api/ads/mine item shape (owner-facing "My ads" list). */
export type AdMine = UserAd;

/** POST /api/ads/:id/bump response. */
export interface AdBumpResult {
  ok: true;
  bumped_at: string;
}

/**
 * Response of the endpoints that re-run moderation on an existing ad:
 * POST /api/ads/:id/unarchive and PATCH /api/ads/:id.
 */
export interface AdModerateResult {
  ok: true;
  status: 'approved' | 'pending' | 'rejected';
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

/**
 * Body for POST /api/share/prepare. Two shapes, discriminated by `kind`:
 *   • a VACANCY card — { vacancyId } (kind defaults to 'vacancy' server-side), or
 *   • the APP-invite card — { kind: 'app' } (no vacancy).
 * The backend treats an absent `kind` as 'vacancy' for backward compat.
 */
export type SharePrepareInput =
  | { kind?: 'vacancy'; vacancyId: string }
  | { kind: 'app' };

/**
 * POST /api/share/prepare — mint a Telegram "prepared inline message" for the rich
 * shared card (Bot API 8.0 `savePreparedInlineMessage`) — either a vacancy card or
 * the app-invite card (see SharePrepareInput). On success the backend returns
 * `preparedMessageId` (handed to WebApp.shareMessage) plus its `expiresAt`. On the
 * opt-out path it returns `{ fallback: true }` — the client then uses the existing
 * plain link-share instead (older clients / browser mock / any backend-side reason
 * to skip the rich card). The referral binding lives inside the prepared card's
 * button server-side; the client never does attribution here.
 */
export interface SharePrepareResult {
  ok: true;
  /** Present on the success path only — pass straight to WebApp.shareMessage(). */
  preparedMessageId?: string;
  /** Unix timestamp (seconds) when the prepared message expires (informational). */
  expiresAt?: number;
  /** true = the client must fall back to the plain link-share. */
  fallback?: boolean;
}
