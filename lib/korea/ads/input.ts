// lib/korea/ads/input.ts
//
// Shared parse + validate for a user-ad payload (the AdInput the mini app POSTs on
// create and PATCHes on edit). Extracted from adsCreate so create AND edit run
// BYTE-IDENTICAL field validation and moderation-text assembly — an edit path that
// diverged here could let a changed ad skip a check the create path applies ("Мои
// объявления"). Pure (no DB / no I/O) → unit-testable without a database.
//
// SECURITY (007 + Sanya §5.2): the body text is DATA, never an instruction. We only
// whitelist enum fields against the closed parser vocab, trim/clamp free text, and
// coerce tri-state booleans. The moderation VERDICT is made elsewhere (moderation.ts
// decideAdModeration) on the text adModText() assembles.

import { WORK_TYPES, VISA_TYPES, PLACEMENT_FEES, CONTACT_KINDS } from '../parser/prompt.js';

/** Canonical UUID shape, shared by the ad handlers that validate a path :id. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WORK_TYPE_SET = new Set<string>(WORK_TYPES);
const VISA_TYPE_SET = new Set<string>(VISA_TYPES);
const PLACEMENT_FEE_SET = new Set<string>(PLACEMENT_FEES);
const CONTACT_KIND_SET = new Set<string>(CONTACT_KINDS);

/** The raw JSON body of POST /api/ads and PATCH /api/ads/:id — every field is untrusted. */
export interface AdBody {
  city_slug?: unknown;
  city_text?: unknown;
  region_slug?: unknown;
  work_type?: unknown;
  visa_types?: unknown;
  placement_fee?: unknown;
  has_housing?: unknown;
  has_meals?: unknown;
  salary_text?: unknown;
  title?: unknown;
  description?: unknown;
  contact_raw?: unknown;
  contact_kind?: unknown;
  housing_terms?: unknown;
  meals_info?: unknown;
  schedule?: unknown;
}

/** The validated, DB-ready fields of a user ad (identical for create and edit). */
export interface AdFields {
  title: string;
  description: string;
  contactRaw: string;
  workType: string;
  visaTypes: string[];
  placementFee: string;
  contactKind: string | null;
  hasHousing: boolean | null;
  hasMeals: boolean | null;
  salaryText: string | null;
  housingTerms: string | null;
  mealsInfo: string | null;
  schedule: string | null;
  reqRegion: string | null;
  reqCitySlug: string | null;
  reqCityText: string | null;
}

const s = (v: unknown, max = 2000): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const tri = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const visaArr = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && VISA_TYPE_SET.has(x)))] : [];

export type ParseResult = { ok: true; fields: AdFields } | { ok: false; error: string };

/**
 * Parse + validate a user-ad payload. Same whitelist/clamp rules for create and edit
 * (the mini app always sends the FULL AdInput — there is no partial patch). title,
 * description and contact_raw are required; everything else falls back to a safe default.
 */
export function parseAdInput(body: AdBody | null): ParseResult {
  const title = s(body?.title, 120);
  const description = s(body?.description, 4000);
  const contactRaw = s(body?.contact_raw, 200);
  if (!title || !description || !contactRaw) {
    return { ok: false, error: 'title, description and contact_raw are required' };
  }
  const workType = typeof body?.work_type === 'string' && WORK_TYPE_SET.has(body.work_type) ? body.work_type : 'other';
  const visaTypes = visaArr(body?.visa_types);
  const placementFee =
    typeof body?.placement_fee === 'string' && PLACEMENT_FEE_SET.has(body.placement_fee) ? body.placement_fee : 'unknown';
  const contactKind =
    typeof body?.contact_kind === 'string' && CONTACT_KIND_SET.has(body.contact_kind) ? body.contact_kind : null;
  return {
    ok: true,
    fields: {
      title,
      description,
      contactRaw,
      workType,
      visaTypes,
      placementFee,
      contactKind,
      hasHousing: tri(body?.has_housing),
      hasMeals: tri(body?.has_meals),
      salaryText: s(body?.salary_text, 500),
      housingTerms: s(body?.housing_terms, 1000),
      mealsInfo: s(body?.meals_info, 1000),
      schedule: s(body?.schedule, 500),
      reqRegion: s(body?.region_slug, 60),
      reqCitySlug: s(body?.city_slug, 60),
      reqCityText: s(body?.city_text, 60),
    },
  };
}

/**
 * The moderation text (title + description + extras) — DATA, never an instruction.
 * IDENTICAL assembly for create, edit AND unarchive so the classifier always sees the
 * same shape. Takes the six parts so the create/edit path (AdFields) and the unarchive
 * path (a stored row) both call it instead of re-deriving the string.
 */
export function adModText(
  title: string | null,
  description: string | null,
  salaryText: string | null,
  schedule: string | null,
  housingTerms: string | null,
  mealsInfo: string | null,
): string {
  return [title, description, salaryText, schedule, housingTerms, mealsInfo].filter(Boolean).join('\n');
}
