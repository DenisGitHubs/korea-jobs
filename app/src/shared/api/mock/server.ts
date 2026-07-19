/**
 * In-memory mock backend for browser dev. Mirrors the API contract 1:1 so the
 * real backend can drop in later with zero screen changes. The feed and detail
 * NEVER return `contact`; it is served only by the dedicated reveal endpoint.
 */
import type {
  AdCreateResult,
  AdInput,
  Me,
  Page,
  RawRevealView,
  RawView,
  Subscription,
  UserAd,
  UserAdStatus,
  VacancyView,
  VisaType,
  WorkType,
} from '../../types/api';
import {
  CITIES,
  DEFAULT_ME,
  DEFAULT_REFERRAL,
  INITIAL_SAVED_IDS,
  MOCK_SOURCES_COUNT,
  RAW_ITEMS,
  RAW_REVEALS,
  buildMyAds,
  buildVacancies,
  type MockVacancy,
} from './fixtures';

const PAGE_SIZE = 8;
const ALL: MockVacancy[] = buildVacancies();

/** User-ad lifetime used for expires_at on approve/bump (mirrors user_ad_ttl_days). */
const AD_TTL_MS = 14 * 86400000;
/** Bump cooldown (mirrors user_ad_bump_min_hours default). */
const BUMP_COOLDOWN_MS = 12 * 3600000;
/** Edit anti-hammer window (mirrors user_ad_edit_min_minutes default). */
const EDIT_MIN_MS = 10 * 60000;

// Mutable session state (resets on reload).
let me: Me = structuredClone(DEFAULT_ME);
let myAds: UserAd[] = buildMyAds();
/** Last-edit timestamps (ms) per ad id — drives the PATCH anti-hammer 429. */
const adUpdatedAt = new Map<string, number>();
/** Bookmarked offer ids (source of truth for is_saved in every projection). */
const savedIds = new Set<string>(INITIAL_SAVED_IDS);

interface MockError {
  __mockHttp: number;
  __mockBody: { error: string; errorId: string };
}

function fail(status: number, error: string): never {
  const e = new Error(error) as Error & Partial<MockError>;
  e.__mockHttp = status;
  e.__mockBody = { error, errorId: 'mock' };
  throw e;
}

const delay = (ms = 200): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Feed/detail projection: drop the contact, project the live is_saved state. */
function withoutContact(v: MockVacancy): VacancyView {
  const copy: MockVacancy = { ...v, is_saved: savedIds.has(v.id) };
  delete copy.contact;
  return copy;
}

function csv(sp: URLSearchParams, key: string): string[] {
  return (sp.get(key) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** websearch-ish AND match: every token (split on dots/spaces) must appear. */
function matchesQuery(v: MockVacancy, q: string): boolean {
  const tokens = q
    .replace(/\./g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return true;
  const hay = [
    v.description,
    v.employer ?? '',
    v.salary_text ?? '',
    v.city ? Object.values(v.city.name).join(' ') : '',
  ]
    .join(' ')
    .toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

function filterFeed(sp: URLSearchParams): MockVacancy[] {
  const cities = csv(sp, 'cities');
  const regions = csv(sp, 'regions');
  const workTypes = csv(sp, 'work_types') as WorkType[];
  const visa = csv(sp, 'visa') as VisaType[];
  const paid = sp.get('paid'); // 'free' | 'paid' | null
  const housing = sp.get('housing') === 'true';
  const meals = sp.get('meals') === 'true';
  const q = sp.get('q') ?? '';
  const freshness = Number.parseInt(sp.get('freshness') ?? '', 10);

  let items = ALL;
  if (cities.length) items = items.filter((v) => v.city != null && cities.includes(v.city.slug));
  if (regions.length) items = items.filter((v) => v.region_slug != null && regions.includes(v.region_slug));
  if (workTypes.length) items = items.filter((v) => workTypes.includes(v.work_type));

  if (visa.length) {
    items = items.filter((v) => {
      // Permissive: unstated (empty) and 'any' always pass.
      if (!v.visa_types.length || v.visa_types.includes('any')) return true;
      return v.visa_types.some((x) => visa.includes(x));
    });
  }
  if (paid === 'free' || paid === 'paid') {
    // 'unknown' (not stated) always passes.
    items = items.filter((v) => v.placement_fee === 'unknown' || v.placement_fee === paid);
  }
  if (housing) items = items.filter((v) => v.has_housing === true || v.has_housing === null);
  if (meals) items = items.filter((v) => v.has_meals === true || v.has_meals === null);
  if (q.trim()) items = items.filter((v) => matchesQuery(v, q));

  if (freshness === 1 || freshness === 3 || freshness === 7 || freshness === 14) {
    const cutoff = Date.now() - freshness * 86400000;
    items = items.filter((v) => new Date(v.posted_at).getTime() >= cutoff);
  }
  return items;
}

/** Decide a fate for a submitted ad so all three result states are reachable. */
function moderateAd(input: AdInput): { status: AdCreateResult['status']; reason: string | null } {
  const desc = (input.description ?? '').trim();
  const contact = (input.contact_raw ?? '').trim();
  if (desc.length < 15) return { status: 'rejected', reason: 'too_short' };
  if (!contact) return { status: 'rejected', reason: 'no_contact' };
  // Demo hook: a description containing "reject" is bounced by "moderation".
  if (desc.toLowerCase().includes('reject')) return { status: 'rejected', reason: 'policy' };
  // Even-length descriptions go to manual review to exercise the "pending" UI.
  if (desc.length % 2 === 0) return { status: 'pending', reason: null };
  return { status: 'approved', reason: null };
}

/** Re-moderate an existing ad by its stored text (unarchive path). */
function moderateStored(ad: UserAd): { status: AdCreateResult['status']; reason: string | null } {
  return moderateAd({
    title: ad.title,
    description: ad.description,
    contact_raw: ad.contact_raw ?? '',
  });
}

/** Build the feed (VacancyView) projection of an approved user ad. */
function feedItemFromAd(ad: UserAd, postedAt: string): MockVacancy {
  return {
    id: ad.id,
    city: ad.city,
    region_slug: ad.region_slug,
    work_type: ad.work_type,
    gender: 'any',
    salary_text: ad.salary_text,
    salary_min: null,
    salary_max: null,
    salary_period: null,
    employer: null,
    description: ad.description,
    posted_at: postedAt,
    has_contact: Boolean(ad.contact_raw),
    visa_types: ad.visa_types,
    placement_fee: ad.placement_fee,
    has_housing: ad.has_housing,
    has_meals: ad.has_meals,
    source_kind: 'user',
    repost: false,
    is_saved: false,
    contact: ad.contact_raw ? { kind: ad.contact_kind ?? 'other', value: ad.contact_raw } : undefined,
  };
}

/** Drop an ad from the feed (used on archive / delete / before a re-approve). */
function removeFromFeed(id: string): void {
  const i = ALL.findIndex((v) => v.id === id);
  if (i >= 0) ALL.splice(i, 1);
}

/** Re-insert (or refresh) an approved ad at the top of the feed. */
function upsertFeed(ad: UserAd, postedAt: string): void {
  removeFromFeed(ad.id);
  ALL.unshift(feedItemFromAd(ad, postedAt));
}

export async function handleMock(method: string, path: string, body?: unknown): Promise<unknown> {
  await delay();

  const url = new URL('http://mock' + path);
  const p = url.pathname.replace(/^\/api/, '');
  const seg = p.split('/').filter(Boolean);

  if (method === 'GET' && p === '/cities') {
    return CITIES;
  }

  if (seg[0] === 'vacancies') {
    // GET /vacancies — filtered, cursor-paginated feed (no contacts).
    if (method === 'GET' && seg.length === 1) {
      const cursor = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0;
      const items = filterFeed(url.searchParams);
      const slice = items.slice(cursor, cursor + PAGE_SIZE).map(withoutContact);
      const nextCursor = cursor + PAGE_SIZE < items.length ? String(cursor + PAGE_SIZE) : null;
      const page: Page<VacancyView> = { items: slice, next_cursor: nextCursor };
      return page;
    }

    // GET /vacancies/count — match count (same filter/union as the feed).
    // Must precede the parametric /vacancies/:id route below.
    if (method === 'GET' && seg.length === 2 && seg[1] === 'count') {
      return { count: filterFeed(url.searchParams).length };
    }

    // GET /vacancies/:id — single card (no contact).
    if (method === 'GET' && seg.length === 2) {
      const v = ALL.find((x) => x.id === seg[1]);
      if (!v) return fail(404, 'not_found');
      return withoutContact(v);
    }

    // GET /vacancies/:id/contact — the reveal endpoint (explicit user action).
    if (method === 'GET' && seg.length === 3 && seg[2] === 'contact') {
      const v = ALL.find((x) => x.id === seg[1]);
      if (!v) return fail(404, 'not_found');
      return { contact: v.contact ?? null };
    }

    // POST /vacancies/:id/report — flag for moderation.
    if (method === 'POST' && seg.length === 3 && seg[2] === 'report') {
      const v = ALL.find((x) => x.id === seg[1]);
      if (!v) return fail(404, 'not_found');
      return { ok: true };
    }

    // POST /vacancies/:id/save — bookmark; DELETE — remove bookmark (idempotent).
    if (seg.length === 3 && seg[2] === 'save') {
      const v = ALL.find((x) => x.id === seg[1]);
      if (!v) return fail(404, 'not_found');
      if (method === 'POST') {
        savedIds.add(seg[1]);
        return { is_saved: true };
      }
      if (method === 'DELETE') {
        savedIds.delete(seg[1]);
        return { is_saved: false };
      }
    }
  }

  if (method === 'GET' && p === '/stats') {
    return { vacancies_count: ALL.length, sources_count: MOCK_SOURCES_COUNT };
  }

  if (method === 'GET' && p === '/saved') {
    const cursor = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0;
    const items = ALL.filter((v) => savedIds.has(v.id));
    const slice = items.slice(cursor, cursor + PAGE_SIZE).map(withoutContact);
    const next_cursor = cursor + PAGE_SIZE < items.length ? String(cursor + PAGE_SIZE) : null;
    const page: Page<VacancyView> = { items: slice, next_cursor };
    return page;
  }

  if (method === 'GET' && p === '/raw') {
    const cursor = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0;
    const slice = RAW_ITEMS.slice(cursor, cursor + PAGE_SIZE);
    const next_cursor = cursor + PAGE_SIZE < RAW_ITEMS.length ? String(cursor + PAGE_SIZE) : null;
    const page: Page<RawView> = { items: slice, next_cursor };
    return page;
  }

  // POST /raw/reveal — reveal the original (unfiltered) text with the contact inline.
  // Idempotent: re-revealing the same id keeps returning 200 (no limit accounting here).
  if (method === 'POST' && p === '/raw/reveal') {
    const b = (body ?? {}) as { raw_id?: unknown };
    const id = typeof b.raw_id === 'string' ? b.raw_id.trim() : '';
    if (!id) return fail(400, 'bad_request');
    const text = RAW_REVEALS[id];
    if (!text) return fail(404, 'not_found');
    const view: RawRevealView = { id, text };
    return view;
  }

  if (method === 'GET' && p === '/me') {
    return me;
  }

  if (method === 'GET' && p === '/referral') {
    return DEFAULT_REFERRAL;
  }

  if (method === 'POST' && p === '/terms/accept') {
    me = { ...me, terms: { ...me.terms, required: false } };
    return { ok: true, version: me.terms.version };
  }

  if (method === 'POST' && p === '/onboarded') {
    me = { ...me, onboarded: true };
    return { onboarded: true };
  }

  if (method === 'POST' && p === '/subscription') {
    const b = (body ?? {}) as Partial<Subscription>;
    const next: Subscription = {
      city_slugs: Array.isArray(b.city_slugs) ? b.city_slugs.map(String) : [],
      work_types: Array.isArray(b.work_types) ? b.work_types.map(String) : [],
      notify: typeof b.notify === 'boolean' ? b.notify : true,
      visa_types: Array.isArray(b.visa_types) ? (b.visa_types as VisaType[]) : [],
      placement_fee: b.placement_fee ?? null,
      require_housing: typeof b.require_housing === 'boolean' ? b.require_housing : null,
      require_meals: typeof b.require_meals === 'boolean' ? b.require_meals : null,
    };
    me = { ...me, subscription: next };
    return next;
  }

  if (seg[0] === 'ads') {
    // GET /ads/mine — the current user's ads (any status, incl. archived).
    // Wrapped as { items } to mirror the real backend (lib/korea/ads/rw.ts).
    if (method === 'GET' && seg.length === 2 && seg[1] === 'mine') {
      return { items: myAds };
    }
    // POST /ads — submit an ad.
    if (method === 'POST' && seg.length === 1) {
      const input = (body ?? {}) as AdInput;
      const { status, reason } = moderateAd(input);
      const id = `ua-${Date.now().toString(36)}`;
      const c = input.city_slug ? CITIES.find((x) => x.slug === input.city_slug) ?? null : null;
      const now = new Date().toISOString();
      const uaStatus: UserAdStatus = status;
      const ad: UserAd = {
        id,
        city: c ? { slug: c.slug, name: c.name } : null,
        city_text: input.city_text ?? null,
        region_slug: input.region_slug ?? c?.region_slug ?? null,
        work_type: input.work_type ?? 'other',
        visa_types: input.visa_types ?? [],
        placement_fee: input.placement_fee ?? 'unknown',
        has_housing: input.has_housing ?? null,
        has_meals: input.has_meals ?? null,
        salary_text: input.salary_text ?? null,
        title: input.title,
        description: input.description,
        contact_raw: input.contact_raw,
        contact_kind: input.contact_kind ?? null,
        housing_terms: input.housing_terms ?? null,
        meals_info: input.meals_info ?? null,
        schedule: input.schedule ?? null,
        status: uaStatus,
        reject_reason: reason,
        created_at: now,
        bumped_at: null,
        expires_at: status === 'approved' ? new Date(Date.now() + AD_TTL_MS).toISOString() : null,
      };
      myAds.unshift(ad);

      // Approved ads immediately appear in the feed as a user-sourced item.
      if (status === 'approved') upsertFeed(ad, now);
      const result: AdCreateResult = { id: status === 'rejected' ? null : id, status };
      return result;
    }

    // Actions on a single ad: /ads/:id and /ads/:id/<action>. Author is implicit
    // in the mock (the session user owns every ad in `myAds`).
    const id = seg[1];
    const idx = id ? myAds.findIndex((a) => a.id === id) : -1;

    // POST /ads/:id/bump — refresh freshness; 429 within the cooldown window.
    if (method === 'POST' && seg.length === 3 && seg[2] === 'bump') {
      if (idx < 0) return fail(404, 'not_found');
      const ad = myAds[idx];
      if (ad.status !== 'approved') return fail(400, 'bad_request');
      const base = Math.max(
        new Date(ad.created_at).getTime(),
        ad.bumped_at ? new Date(ad.bumped_at).getTime() : 0,
      );
      if (Date.now() - base < BUMP_COOLDOWN_MS) return fail(429, 'rate_limited');
      const nowMs = Date.now();
      const bumpedAt = new Date(nowMs).toISOString();
      const updated: UserAd = { ...ad, bumped_at: bumpedAt, expires_at: new Date(nowMs + AD_TTL_MS).toISOString() };
      myAds[idx] = updated;
      upsertFeed(updated, bumpedAt); // reflects greatest(created_at, bumped_at) in the feed
      return { ok: true, bumped_at: bumpedAt };
    }

    // POST /ads/:id/archive — park the ad off the feed.
    if (method === 'POST' && seg.length === 3 && seg[2] === 'archive') {
      if (idx < 0) return fail(404, 'not_found');
      const ad = myAds[idx];
      if (!['approved', 'pending', 'expired', 'rejected'].includes(ad.status)) {
        return fail(400, 'bad_request');
      }
      myAds[idx] = { ...ad, status: 'archived' };
      removeFromFeed(ad.id);
      return { ok: true };
    }

    // POST /ads/:id/unarchive — re-run moderation on the stored text.
    if (method === 'POST' && seg.length === 3 && seg[2] === 'unarchive') {
      if (idx < 0) return fail(404, 'not_found');
      const ad = myAds[idx];
      if (ad.status !== 'archived') return fail(400, 'bad_request');
      const { status, reason } = moderateStored(ad);
      const now = new Date().toISOString();
      const updated: UserAd = {
        ...ad,
        status,
        reject_reason: reason,
        expires_at: status === 'approved' ? new Date(Date.now() + AD_TTL_MS).toISOString() : ad.expires_at,
      };
      myAds[idx] = updated;
      if (status === 'approved') upsertFeed(updated, now);
      return { ok: true, status };
    }

    // PATCH /ads/:id — edit + mandatory re-moderation; anti-hammer 429.
    if (method === 'PATCH' && seg.length === 2) {
      if (idx < 0) return fail(404, 'not_found');
      const ad = myAds[idx];
      if (ad.status === 'taken_down') return fail(400, 'bad_request');
      const lastEdit = adUpdatedAt.get(ad.id) ?? new Date(ad.created_at).getTime();
      if (Date.now() - lastEdit < EDIT_MIN_MS) return fail(429, 'rate_limited');
      const input = (body ?? {}) as AdInput;
      const { status, reason } = moderateAd(input);
      const c = input.city_slug ? CITIES.find((x) => x.slug === input.city_slug) ?? null : null;
      const now = new Date().toISOString();
      const updated: UserAd = {
        ...ad,
        title: input.title,
        description: input.description,
        contact_raw: input.contact_raw,
        contact_kind: input.contact_kind ?? ad.contact_kind,
        work_type: input.work_type ?? ad.work_type,
        visa_types: input.visa_types ?? [],
        placement_fee: input.placement_fee ?? 'unknown',
        has_housing: input.has_housing ?? null,
        has_meals: input.has_meals ?? null,
        salary_text: input.salary_text ?? null,
        housing_terms: input.housing_terms ?? null,
        meals_info: input.meals_info ?? null,
        schedule: input.schedule ?? null,
        city: c ? { slug: c.slug, name: c.name } : input.city_slug === null ? null : ad.city,
        city_text: input.city_text ?? null,
        region_slug: input.region_slug ?? c?.region_slug ?? ad.region_slug,
        status,
        reject_reason: reason,
        expires_at: status === 'approved' ? new Date(Date.now() + AD_TTL_MS).toISOString() : ad.expires_at,
      };
      myAds[idx] = updated;
      adUpdatedAt.set(ad.id, Date.now());
      removeFromFeed(ad.id);
      if (status === 'approved') upsertFeed(updated, now);
      return { ok: true, status };
    }

    // DELETE /ads/:id — permanent hard delete.
    if (method === 'DELETE' && seg.length === 2) {
      if (idx < 0) return fail(404, 'not_found');
      myAds = myAds.filter((a) => a.id !== id);
      removeFromFeed(id);
      return { ok: true };
    }
  }

  if (method === 'POST' && p === '/cooperation') {
    const b = (body ?? {}) as { contact?: string; message?: string };
    if (!b.contact && !b.message) return fail(400, 'empty');
    return { ok: true };
  }

  return fail(404, 'not_found');
}
