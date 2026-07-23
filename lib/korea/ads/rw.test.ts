// lib/korea/ads/rw.test.ts
//
// adsCreate — the "Другой город" path (city_slug=null + free-text city_text), the owner's repro.
// The AI is mocked (decideAdModeration) and the DB is a fake tagged-template `sql`, so we exercise
// the REAL handler logic (resolveAdCityIds / resolveAdRegionSlugs + the user_ads INSERT assembly)
// without Postgres or Anthropic and pin that this path returns 200, never a 500.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted fake state so the vi.mock factories (hoisted above the imports) can reach it.
const h = vi.hoisted(() => {
  const state = {
    queries: [] as { text: string; params: unknown[] }[],
    citiesRows: [] as unknown[],
    insertId: '11111111-1111-1111-1111-111111111111' as string | null,
    throwOnInsert: false,
  };
  const fakeSql = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<unknown[]> => {
    const text = typeof strings === 'string' ? strings : strings.join(' ? ');
    state.queries.push({ text, params });
    if (text.includes('from cities')) return Promise.resolve(state.citiesRows);
    if (text.includes('insert into user_ads')) {
      if (state.throwOnInsert) return Promise.reject(new Error('column "city_ids" of relation "user_ads" does not exist'));
      return Promise.resolve(state.insertId ? [{ id: state.insertId }] : []);
    }
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('../core/context.js', () => ({
  authenticate: async () => ({
    ok: true,
    user: { id: '00000000-0000-0000-0000-000000000001', telegramId: '1', publicId: 'abc', lang: 'ru', allowsWriteToPm: true, isBlocked: false },
  }),
}));
vi.mock('../config.js', () => ({
  getConfigNumber: async (_k: string, fb: number) => fb,
  getConfigBool: async (_k: string, fb: boolean) => fb,
  getConfigString: async (_k: string, fb: string) => fb,
}));
vi.mock('../bot/telegram.js', () => ({ sendMessage: async () => ({ ok: true }) }));
vi.mock('../admin/auth.js', () => ({ adminRecipients: async () => [], requireAdmin: async () => ({ ok: false }) }));

// The AI mock: decideAdModeration is the single moderation verdict. For the repro the ad is a clean
// vacancy the model auto-approves and resolves NO city slug (so the free-text city_text must survive).
const decideMock = vi.fn(async () => ({
  status: 'approved' as const,
  rejectReason: null as string | null,
  item: { is_vacancy: true, confidence: 0.95, city_slug: null as string | null, region_slug: null as string | null } as unknown,
  cityIdBySlug: new Map<string, string>(),
  aiConfidence: 0.95 as number | null,
}));
vi.mock('./moderation.js', () => ({
  decideAdModeration: (...a: unknown[]) => decideMock(...(a as [])),
  recordModerationExample: async () => {},
}));

import { adsCreate } from './rw.js';
import type { ReqLike, ResLike } from '../core/http.js';

function makeReq(body: unknown): ReqLike {
  return { method: 'POST', headers: { authorization: 'tma stub' }, body };
}
function makeRes(): ResLike & { _status: number; _body: unknown } {
  return {
    _status: 0,
    _body: undefined,
    statusCode: 0,
    setHeader() {},
    end(b: string) {
      this._status = this.statusCode;
      this._body = JSON.parse(b);
    },
  };
}

const reproBody = {
  title: 'Рабочий на завод',
  description: 'Требуется рабочий на производство, стабильная зарплата, оформление.',
  contact_raw: '+821012345678',
  work_type: 'factory',
  visa_types: ['e9'],
  placement_fee: 'free',
  has_housing: true,
  has_meals: false,
  // The owner's repro: "Другой город" → no directory slug, free-text city only.
  city_slug: null,
  city_text: 'Кёнджу',
  region_slug: null,
};

beforeEach(() => {
  h.state.queries = [];
  h.state.citiesRows = [];
  h.state.insertId = '11111111-1111-1111-1111-111111111111';
  h.state.throwOnInsert = false;
  decideMock.mockClear();
});

describe('adsCreate — "Другой город" (city_text only, no city_slug) does NOT 500', () => {
  it('returns 200 with the created id and status, city_text kept, city_ids empty', async () => {
    const req = makeReq(reproBody);
    const res = makeRes();
    await adsCreate(req, res);

    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ id: '11111111-1111-1111-1111-111111111111', status: 'approved' });

    const insert = h.state.queries.find((q) => q.text.includes('insert into user_ads'));
    expect(insert, 'the handler reached the user_ads INSERT').toBeTruthy();
    // The INSERT param order (see rw.ts): [author, cityId, cityIds, cityText, regionSlug, regionSlugs, ...].
    const p = insert!.params;
    expect(p[1]).toBeNull(); // city_id — no directory pick and AI resolved none
    expect(Array.isArray(p[2]) && (p[2] as unknown[]).length === 0).toBe(true); // city_ids — empty uuid[]
    expect(p[3]).toBe('Кёнджу'); // city_text — the free-text city is preserved
    expect(Array.isArray(p[5])).toBe(true); // region_slugs — a (possibly empty) text[]
  });

  it('surfaces a DB INSERT fault as a 500 (regression guard for the missing-column class of failure)', async () => {
    h.state.throwOnInsert = true;
    const req = makeReq(reproBody);
    const res = makeRes();
    await adsCreate(req, res);
    expect(res._status).toBe(500);
  });
});
