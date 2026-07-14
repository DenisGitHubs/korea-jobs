/**
 * In-memory mock backend for browser dev. Mirrors the API contract 1:1 so the
 * real backend can drop in later with zero screen changes. The feed and detail
 * NEVER return `contact`; it is served only by the dedicated reveal endpoint.
 */
import type { Me, Page, Subscription, VacancyView, WorkType } from '../../types/api';
import { CITIES, DEFAULT_ME, buildVacancies } from './fixtures';

const PAGE_SIZE = 8;
const ALL = buildVacancies();

// Mutable session state (resets on reload) — lets Save + notify toggle persist.
let me: Me = structuredClone(DEFAULT_ME);

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

/** Feed/detail projection: drop the contact, keep the has_contact flag. */
function withoutContact(v: VacancyView): VacancyView {
  const copy: VacancyView = { ...v };
  delete copy.contact;
  return copy;
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
      const cities = (url.searchParams.get('cities') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const workTypes = (url.searchParams.get('work_types') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as WorkType[];
      const cursor = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0;

      let items = ALL;
      if (cities.length) items = items.filter((v) => v.city != null && cities.includes(v.city.slug));
      if (workTypes.length) items = items.filter((v) => workTypes.includes(v.work_type));

      const slice = items.slice(cursor, cursor + PAGE_SIZE).map(withoutContact);
      const nextCursor = cursor + PAGE_SIZE < items.length ? String(cursor + PAGE_SIZE) : null;
      const page: Page<VacancyView> = { items: slice, next_cursor: nextCursor };
      return page;
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
  }

  if (method === 'GET' && p === '/me') {
    return me;
  }

  if (method === 'POST' && p === '/subscription') {
    const b = (body ?? {}) as Partial<Subscription>;
    const next: Subscription = {
      city_slugs: Array.isArray(b.city_slugs) ? b.city_slugs.map(String) : [],
      work_types: Array.isArray(b.work_types) ? b.work_types.map(String) : [],
      notify: typeof b.notify === 'boolean' ? b.notify : true,
    };
    me = { ...me, subscription: next };
    return next;
  }

  return fail(404, 'not_found');
}
