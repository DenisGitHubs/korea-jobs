/**
 * THE single contact point between the frontend and /api. Screens never call
 * fetch() directly. Mock mode (VITE_API_MODE=mock) lazy-loads an in-memory
 * server so the whole UI runs in a plain browser with no backend.
 */
import { authHeader } from '../auth/telegram';
import { hubSessionLost } from '../../lib/hubGate';
import type {
  AdBumpResult,
  AdCreateResult,
  AdInput,
  AdModerateResult,
  City,
  CooperationInput,
  HubSession,
  Me,
  Page,
  RawRevealView,
  RawView,
  ReferralView,
  SharePrepareInput,
  SharePrepareResult,
  Stats,
  Subscription,
  TermsAcceptResult,
  UserAd,
  VacancyContactReveal,
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
    // "Who are you?" is answered in exactly ONE place — here, the only fetch in
    // the app — and not in twenty screens. Inside the AppHub Studio shell a 401
    // is terminal: the day-long pass is dead, the ticket was single use and the
    // fragment is wiped, so there is nothing left to retry with and every next
    // request would 401 too. The boot code subscribes in 'hub' mode ONLY (see
    // lib/hubGate.ts) and swaps the app for the honest "sign-in expired" screen;
    // in Telegram nobody is subscribed and this line does nothing at all.
    if (res.status === 401) hubSessionLost();
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
    // "1"/"0"; omitted when unset (server treats absent as "1" = included).
    no_city: q.no_city === undefined ? undefined : q.no_city ? '1' : '0',
    cursor: q.cursor,
  });
}

export const api = {
  /**
   * POST /auth/hub — trade the AppHub Studio launch ticket for our own session
   * pass. The only call made before the app mounts and the only one that
   * carries no identity of its own; the ticket goes in the body and nowhere
   * else. A refusal is a plain ApiError and the STATUS matters: the caller
   * tells "our service is down, try again" (503/5xx/no network) apart from
   * "this sign-in is spent, get a new one from the shell" (4xx) — see
   * lib/hubGate.ts. Neither of them is the "open in Telegram" landing page.
   */
  authHub: (ticket: string) => request<HubSession>('POST', '/auth/hub', { body: { hub_ticket: ticket } }),

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

  /**
   * GET /vacancies/:id/contact — reveal on explicit user action only. Carries the
   * user's remaining daily reveal budget (`reveals_left`) when the backend ships it.
   */
  vacancyContact: (id: string) =>
    request<VacancyContactReveal>('GET', `/vacancies/${encodeURIComponent(id)}/contact`),

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

  /** GET /ads/mine — the current user's submitted ads (any status, incl. archived).
   *  Server wraps the list as { items }; unwrap so callers get a bare array. */
  adsMine: () => request<{ items: UserAd[] }>('GET', '/ads/mine').then((r) => r.items),

  /** POST /ads/:id/bump — refresh freshness (author only, approved & non-archived; 429 within cooldown). */
  adBump: (id: string) =>
    request<AdBumpResult>('POST', `/ads/${encodeURIComponent(id)}/bump`, { body: {} }),

  /** POST /ads/:id/archive — park the ad off the feed (author only). */
  adArchive: (id: string) =>
    request<{ ok: true }>('POST', `/ads/${encodeURIComponent(id)}/archive`, { body: {} }),

  /** POST /ads/:id/unarchive — send an archived ad back through moderation. */
  adUnarchive: (id: string) =>
    request<AdModerateResult>('POST', `/ads/${encodeURIComponent(id)}/unarchive`, { body: {} }),

  /** PATCH /ads/:id — edit an ad; re-runs moderation (author only). Body = full AdInput. */
  adPatch: (id: string, input: AdInput) =>
    request<AdModerateResult>('PATCH', `/ads/${encodeURIComponent(id)}`, { body: input }),

  /** DELETE /ads/:id — permanently delete an ad (author only, hard delete). */
  adDelete: (id: string) => request<{ ok: true }>('DELETE', `/ads/${encodeURIComponent(id)}`),

  /** POST /cooperation — a partnership / cooperation request (stub). */
  cooperation: (input: CooperationInput) => request<{ ok: true }>('POST', '/cooperation', { body: input }),

  /** GET /referral — invite code/link, loyalty balance and per-tier counters. */
  referral: () => request<ReferralView>('GET', '/referral'),

  /**
   * POST /share/prepare — request a Bot API 8.0 "prepared inline message" for the
   * rich shared card: a vacancy ({ vacancyId }) or the app invite ({ kind: 'app' }).
   * Success: { preparedMessageId, expiresAt }; opt-out: { fallback: true } (client
   * then uses the existing plain link-share).
   */
  sharePrepare: (input: SharePrepareInput) =>
    request<SharePrepareResult>('POST', '/share/prepare', { body: input }),

  /** GET /stats — feed-wide totals for the aggregator bar. */
  stats: () => request<Stats>('GET', '/stats'),
};
