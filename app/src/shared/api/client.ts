/**
 * THE single contact point between the frontend and /api. Screens never call
 * fetch() directly. Mock mode (VITE_API_MODE=mock) lazy-loads an in-memory
 * server so the whole UI runs in a plain browser with no backend.
 */
import { authHeader } from '../auth/telegram';
import type {
  City,
  Me,
  Page,
  Subscription,
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

export const api = {
  /** GET /cities — 30 seed cities, grouped by region on the client. */
  cities: () => request<City[]>('GET', '/cities'),

  /** GET /vacancies — cursor-paginated feed. Never carries contact. */
  vacancies: (q: VacancyQuery) =>
    request<Page<VacancyView>>(
      'GET',
      `/vacancies${qs({
        cities: q.cities?.length ? q.cities.join(',') : undefined,
        work_types: q.work_types?.length ? q.work_types.join(',') : undefined,
        cursor: q.cursor,
      })}`,
    ),

  /** GET /vacancies/:id — single card (no contact). */
  vacancy: (id: string) => request<VacancyView>('GET', `/vacancies/${encodeURIComponent(id)}`),

  /** GET /vacancies/:id/contact — reveal on explicit user action only. */
  vacancyContact: (id: string) =>
    request<{ contact: VacancyContact | null }>('GET', `/vacancies/${encodeURIComponent(id)}/contact`),

  /** GET /me — public id, language, current subscription. */
  me: () => request<Me>('GET', '/me'),

  /** POST /subscription — save chosen cities + work types + notify toggle. */
  saveSubscription: (s: Subscription) => request<Subscription>('POST', '/subscription', { body: s }),
};
