import { create } from 'zustand';
import type { Me, PlacementFee, Subscription, VisaType, WorkType } from '../shared/types/api';

/** The persistent subscription (drives the bot notifications + the feed default). */
export interface SubscriptionValue {
  citySlugs: string[];
  /** Selected province/region slugs (independent of the city selection). */
  regionSlugs: string[];
  workTypes: WorkType[];
  notify: boolean;
  visaTypes: VisaType[];
  placementFee: PlacementFee | null;
  requireHousing: boolean | null;
  requireMeals: boolean | null;
  /** Daily digest opt-in (bot sends one summary a day). Opt-in: defaults to false. */
  digestEnabled: boolean;
  /**
   * Cap on realtime job MESSAGES per day (Seoul time), chosen under the mailing
   * toggle in Settings. THREE states on purpose:
   *   number    — at most that many DMs a day
   *   null      — explicitly "no limit"
   *   undefined — UNKNOWN (this backend does not report the field yet). A save
   *               then OMITS the field, and the server keeps what it has stored —
   *               sending null instead would silently lift someone's limit.
   */
  notifyDailyCap: number | null | undefined;
  /** Include offers with no city (used with the city filter). Defaults to true. */
  noCity: boolean;
}

interface SubscriptionState extends SubscriptionValue {
  loaded: boolean;
  publicId: string;
  termsRequired: boolean;
  termsVersion: string;
  /** First-run onboarding completed (from /me; server-persisted). */
  onboarded: boolean;
  /**
   * Remaining daily contact reveals (from /me, refreshed by each reveal response).
   * `null` = unknown (backend has not shipped the field) → the UI hides the hint.
   */
  revealsLeft: number | null;
  /**
   * Server switch `flags.hide_unverified` (from /me): the "⚠ Не проверено" feed
   * segment is off. Additive/optional field — absent === false (segment shown).
   */
  hideUnverified: boolean;
  hydrate: (m: Me) => void;
  apply: (s: Subscription) => void;
  setNotify: (b: boolean) => void;
  acceptTerms: () => void;
  /** Mark onboarding done locally (after POST /onboarded) so the overlay closes. */
  setOnboarded: () => void;
  /** Update the remaining-reveals counter from a reveal response (ignores undefined). */
  setRevealsLeft: (n: number | undefined) => void;
}

// Owner rule (2026-07-25): mailing is OPT-IN. Nothing may look "already on" before
// the real subscription arrives from /me — neither the settings toggles nor the
// feed nudge (which is driven by `notify`).
const EMPTY: SubscriptionValue = {
  citySlugs: [],
  regionSlugs: [],
  workTypes: [],
  notify: false,
  visaTypes: [],
  placementFee: null,
  requireHousing: null,
  requireMeals: null,
  digestEnabled: false,
  // Unknown until /me answers — never guess a cap for someone who did not pick one.
  notifyDailyCap: undefined,
  noCity: true,
};

/**
 * Normalise the daily-message cap coming from the API.
 *   absent (undefined) -> stays UNKNOWN (see SubscriptionValue.notifyDailyCap)
 *   null / 0 / garbage -> "no limit" (the wire contract of lib/korea/notify/cap.ts)
 *   positive number    -> the cap
 */
function capOf(v: number | null | undefined): number | null | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'number' && v > 0 ? Math.floor(v) : null;
}

function fromSubscription(s: Subscription): SubscriptionValue {
  return {
    citySlugs: s.city_slugs,
    regionSlugs: s.region_slugs ?? [],
    workTypes: s.work_types as WorkType[],
    notify: s.notify,
    visaTypes: s.visa_types ?? [],
    placementFee: s.placement_fee ?? null,
    requireHousing: s.require_housing ?? null,
    requireMeals: s.require_meals ?? null,
    // Absent === off (opt-in): a missing flag must never be shown as an enabled toggle.
    digestEnabled: s.digest_enabled ?? false,
    notifyDailyCap: capOf(s.notify_daily_cap),
    noCity: s.no_city ?? true,
  };
}

/** Read the current subscription slice as a plain SubscriptionValue. */
export function subscriptionValue(s: SubscriptionState): SubscriptionValue {
  return {
    citySlugs: s.citySlugs,
    regionSlugs: s.regionSlugs,
    workTypes: s.workTypes,
    notify: s.notify,
    visaTypes: s.visaTypes,
    placementFee: s.placementFee,
    requireHousing: s.requireHousing,
    requireMeals: s.requireMeals,
    digestEnabled: s.digestEnabled,
    notifyDailyCap: s.notifyDailyCap,
    noCity: s.noCity,
  };
}

/** SubscriptionValue -> API Subscription body. */
export function toSubscription(v: SubscriptionValue): Subscription {
  const body: Subscription = {
    city_slugs: v.citySlugs,
    region_slugs: v.regionSlugs,
    work_types: v.workTypes,
    notify: v.notify,
    visa_types: v.visaTypes,
    placement_fee: v.placementFee,
    require_housing: v.requireHousing,
    require_meals: v.requireMeals,
    digest_enabled: v.digestEnabled,
    no_city: v.noCity,
  };
  // The cap is the ONE field with keep-on-absent semantics server-side: it rides
  // along on every save (the cities screen included) whenever the client knows a
  // value, and is left out entirely while it is unknown, so the stored cap
  // survives a save made by a client that never saw it.
  if (v.notifyDailyCap !== undefined) body.notify_daily_cap = v.notifyDailyCap;
  return body;
}

export const useSubscriptionStore = create<SubscriptionState>((set) => ({
  ...EMPTY,
  loaded: false,
  publicId: '',
  termsRequired: false,
  termsVersion: '',
  // Safe default: assume onboarded until /me says otherwise, so the overlay never
  // flashes before hydrate and a failed /me does not trap the user in onboarding.
  onboarded: true,
  revealsLeft: null,
  // Safe default: the segment stays visible unless the server explicitly hides it.
  hideUnverified: false,
  hydrate: (m) =>
    set({
      ...fromSubscription(m.subscription),
      // The cap normally lives inside `subscription`; fall back to the top-level
      // mirror only when the subscription does not carry the field at all.
      notifyDailyCap: capOf(
        m.subscription?.notify_daily_cap !== undefined ? m.subscription.notify_daily_cap : m.notify_daily_cap,
      ),
      publicId: m.public_id,
      termsRequired: m.terms?.required ?? false,
      termsVersion: m.terms?.version ?? '',
      onboarded: m.onboarded ?? true,
      revealsLeft: typeof m.reveals_left === 'number' ? m.reveals_left : null,
      // Additive flag: absent object / absent key === off.
      hideUnverified: m.flags?.hide_unverified === true,
      loaded: true,
    }),
  apply: (s) =>
    set((st) => ({
      ...fromSubscription(s),
      // A backend that has not shipped `notify_daily_cap` echoes the saved row
      // without it. Keep what the user just picked instead of snapping the chips
      // back to "no limit"; the next /me still tells the truth.
      notifyDailyCap: s.notify_daily_cap !== undefined ? capOf(s.notify_daily_cap) : st.notifyDailyCap,
      loaded: true,
    })),
  setNotify: (b) => set({ notify: b }),
  acceptTerms: () => set({ termsRequired: false }),
  setOnboarded: () => set({ onboarded: true }),
  setRevealsLeft: (n) => {
    if (typeof n === 'number') set({ revealsLeft: n });
  },
}));
