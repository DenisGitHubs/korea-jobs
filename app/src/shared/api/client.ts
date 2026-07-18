/**
 * THE single contact point between the frontend and /api. Screens never call
 * fetch() directly. Mock mode (VITE_API_MODE=mock) lazy-loads an in-memory
 * server so the whole UI runs in a plain browser with no backend.
 */
import { authHeader } from '../auth/telegram';
import type {
  AdCreateResult,
  AdInput,
  City,
  CooperationInput,
  Me,
  Page,
  RawRevealView,
  RawView,
  ReferralView,
  Stats,
  Subscription,
  TermsAcceptResult,
  UserAd,
  VacancyContact,
  VacancyQuery,
  VacancyView,
} from '../types/api';

export class ApiError extends Error {
  readonly http: number;
  readonly code: string;
  constructor(http: number, code: string) {
    super(code);
    this.name = 'ApiError';
    this.http = http;
    this.code = code;
  }
}

/** True when the UI should talk to the in-memory mock instead of a real API. */
export const USE_MOCK = import.meta.env.VITE_API_MODE === 'mock';

/** real: VITE_API_BASE_URL (or same-origin /api). mock: always /api (matched by the mock). */
const REAL_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const MOCK_PREFIX = '/api';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type MockHandler = (method: string, path: string, body?: unknown) => Promise<unknown>;

let mockHandler: MockHandler | null = null;
async function ensureMock(): Promise<MockHandler> {
  if (!mockHandler) {
    const mod = await import('./mock/server');
    mockHandler = mod.handleMock;
  }
  return mockHandler;
}

async function request<T>(method: Method, path: string, opts?: { body?: unknown }): Promise<T> {
  if (USE_MOCK) {
    const handle = await ensureMock();
    try {
      return (await handle(method, MOCK_PREFIX + path, opts?.body)) as T;
    } catch (e) {
      const m = e as { __mockHttp?: number; __mockBody?: { error?: string } };
      if (m.__mockHttp) throw new ApiError(m.__mockHttp, m.__mockBody?.error ?? 'error');
      throw e;
    }
  }

  const headers: Record<string, string> = { ...authHeader() };
  if (opts?.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(REAL_BASE + path, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    let code = 'internal';
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) code = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (!pairs.length) return '';
  return '?' + pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

/** Serialize a VacancyQuery into the GET /vacancies query string. */
function vacancyQuery(q: VacancyQuery): string {
  return qs({
    cities: q.cities?.length ? q.cities.join(',') : undefined,
    work_types: q.work_types?.length ? q.work_types.join(',') : undefined,
    regions: q.regions?.length ? q.regions.join(',') : undefined,
    visa: q.visa?.length ? q.visa.join(',') : undefined,
    paid: q.paid,
    housing: q.housing ? 'true' : undefined,
    meals: q.meals ? 'true' : undefined,
    q: q.q?.trim() ? q.q.trim() : undefined,
    freshness: q.freshness,
    cursor: q.cursor,
  });
}

export const api = {
  /** GET /cities — 30 seed cities, grouped by region on the client. */
  cities: () => request<City[]>('GET', '/cities'),

  /** GET /vacancies — cursor-paginated feed. Never carries contact. */
  vacancies: (q: VacancyQuery) => request<Page<VacancyView>>('GET', `/vacancies${vacancyQuery(q)}`),

  /** GET /vacancies/count — how many offers match `q` (same union/rules as the feed). */
  vacanciesCount: (q: VacancyQuery) =>
    request<{ count: number }>('GET', `/vacancies/count${vacancyQuery(q)}`),

  /** GET /saved — the user's bookmarked offers (same shape as the feed). */
  saved: (q: { cursor?: string } = {}) =>
    request<Page<VacancyView>>('GET', `/saved${qs({ cursor: q.cursor })}`),

  /** GET /raw — unparsed listings (contacts scrubbed), cursor-paginated. */
  raw: (q: { cursor?: string } = {}) => request<Page<RawView>>('GET', `/raw${qs({ cursor: q.cursor })}`),

  /**
   * POST /raw/reveal — reveal the ORIGINAL text (contact inline) of an unverified
   * listing. Spends from the shared daily reveal budget (429 rate_limited when
   * exhausted); idempotent — re-revealing the same raw_id never re-charges it.
   */
  rawReveal: (rawId: string) =>
    request<RawRevealView>('POST', '/raw/reveal', { body: { raw_id: rawId } }),

  /** POST /vacancies/:id/save — bookmark (idempotent). */
  saveVacancy: (id: string) =>
    request<{ is_saved: true }>('POST', `/vacancies/${encodeURIComponent(id)}/save`, { body: {} }),

  /** DELETE /vacancies/:id/save — remove bookmark (idempotent). */
  unsaveVacancy: (id: string) =>
    request<{ is_saved: false }>('DELETE', `/vacancies/${encodeURIComponent(id)}/save`),

  /** GET /vacancies/:id — single card (no contact). */
  vacancy: (id: string) => request<VacancyView>('GET', `/vacancies/${encodeURIComponent(id)}`),

  /** GET /vacancies/:id/contact — reveal on explicit user action only. */
  vacancyContact: (id: string) =>
    request<{ contact: VacancyContact | null }>('GET', `/vacancies/${encodeURIComponent(id)}/contact`),

  /** POST /vacancies/:id/report — flag an offer for moderation. */
  reportVacancy: (id: string, reason?: string) =>
    request<{ ok: true }>('POST', `/vacancies/${encodeURIComponent(id)}/report`, {
      body: reason ? { reason } : {},
    }),

  /** GET /me — public id, language, terms state, current subscription. */
  me: () => request<Me>('GET', '/me'),

  /** POST /terms/accept — record acceptance of the current terms version. */
  acceptTerms: () => request<TermsAcceptResult>('POST', '/terms/accept', { body: {} }),

  /** POST /subscription — persistent filter that drives feed default + bot notifications. */
  saveSubscription: (s: Subscription) => request<Subscription>('POST', '/subscription', { body: s }),

  /** POST /onboarded — mark first-run onboarding complete (idempotent). */
  markOnboarded: () => request<{ onboarded: true }>('POST', '/onboarded', { body: {} }),

  /** POST /ads — submit a user ad; may be approved / pending / rejected. */
  createAd: (input: AdInput) => request<AdCreateResult>('POST', '/ads', { body: input }),

  /** GET /ads/mine — the current user's submitted ads. */
  myAds: () => request<UserAd[]>('GET', '/ads/mine'),

  /** POST /cooperation — a partnership / cooperation request (stub). */
  cooperation: (input: CooperationInput) => request<{ ok: true }>('POST', '/cooperation', { body: input }),

  /** GET /referral — invite code/link, loyalty balance and per-tier counters. */
  referral: () => request<ReferralView>('GET', '/referral'),

  /** GET /stats — feed-wide totals for the aggregator bar. */
  stats: () => request<Stats>('GET', '/stats'),
};
