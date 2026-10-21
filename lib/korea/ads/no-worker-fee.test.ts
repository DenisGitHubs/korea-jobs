// lib/korea/ads/no-worker-fee.test.ts
//
// «Я не беру плату с работников» (owner decision 2026-10-21, draft_0035) — the SERVER side of the
// mandatory placement-form checkbox. A checkbox that lives only in the client is not a
// confirmation: it can be bypassed by posting straight to the API, and in a dispute there is
// nothing to show — which is the entire reason the confirmation exists (a ground for removing the
// ad of an agency that charges workers). So this is load-bearing, not decoration.
//
// Driven through the REAL handlers (adsCreate, and the PATCH the app actually calls — adItem)
// against a fake tagged-template `sql`, so what is pinned is the behaviour a client gets.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    queries: [] as { text: string; params: unknown[] }[],
    insertId: '11111111-1111-1111-1111-111111111111' as string | null,
    tooSoon: false,
  };
  const ownAd = {
    id: '11111111-1111-1111-1111-111111111111',
    status: 'approved',
    created_at: '2026-10-01T00:00:00.000Z',
    bumped_at: null,
    updated_at: '2026-10-01T00:00:00.000Z',
    title: 'Рабочий на завод',
    description: 'Требуется рабочий на производство.',
    salary_text: null,
    schedule: null,
    housing_terms: null,
    meals_info: null,
    work_type: 'factory',
    region_slug: null,
    city_text: null,
    city_slug: null,
  };
  const fakeSql = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<unknown[]> => {
    const text = typeof strings === 'string' ? strings : strings.join(' ? ');
    state.queries.push({ text, params });
    if (text.includes('from cities')) return Promise.resolve([]);
    if (text.includes('insert into user_ads')) return Promise.resolve(state.insertId ? [{ id: state.insertId }] : []);
    if (text.includes('too_soon')) return Promise.resolve([{ too_soon: state.tooSoon }]);
    if (text.includes('from user_ads a')) return Promise.resolve([ownAd]); // findOwnAd
    if (text.includes('update user_ads')) return Promise.resolve([{ id: ownAd.id }]);
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
vi.mock('../notify/author.js', () => ({ notifyAuthorAdDecision: async () => undefined }));

const decideMock = vi.fn(async () => ({
  status: 'approved' as const,
  rejectReason: null as string | null,
  item: { is_vacancy: true, confidence: 0.95, city_slug: null, region_slug: null } as unknown,
  cityIdBySlug: new Map<string, string>(),
  aiConfidence: 0.95 as number | null,
}));
vi.mock('./moderation.js', () => ({
  decideAdModeration: (...a: unknown[]) => decideMock(...(a as [])),
  recordModerationExample: async () => {},
}));

import { adsCreate } from './rw.js';
import { adItem } from './manage.js';
import type { ReqLike, ResLike } from '../core/http.js';

const AD_ID = '11111111-1111-1111-1111-111111111111';

const body = {
  no_worker_fee: true,
  title: 'Рабочий на завод',
  description: 'Требуется рабочий на производство, стабильная зарплата, оформление.',
  contact_raw: '+821012345678',
  work_type: 'factory',
  visa_types: ['e9'],
  placement_fee: 'free',
  has_housing: true,
  has_meals: false,
  city_slug: null,
  city_text: 'Кёнджу',
  region_slug: null,
};

function makeReq(b: unknown, method = 'POST', query: Record<string, string> = {}): ReqLike {
  return { method, headers: { authorization: 'tma stub' }, body: b, query };
}
function makeRes(): ResLike & { _status: number; _body: Record<string, unknown> } {
  return {
    _status: 0,
    _body: {},
    statusCode: 0,
    setHeader() {},
    end(b: string) {
      this._status = this.statusCode;
      this._body = JSON.parse(b) as Record<string, unknown>;
    },
  };
}

const inserts = () => h.state.queries.filter((q) => q.text.includes('insert into user_ads'));
const updates = () => h.state.queries.filter((q) => /update user_ads set\s+city_id/.test(q.text));

beforeEach(() => {
  h.state.queries = [];
  h.state.insertId = AD_ID;
  h.state.tooSoon = false;
  decideMock.mockClear();
});

describe('POST /api/ads — no confirmation, no ad', () => {
  it('🔴 a create WITHOUT the confirmation is refused: 400, own detail, nothing written', async () => {
    const res = makeRes();
    const { no_worker_fee: _omitted, ...withoutConfirmation } = body;

    await adsCreate(makeReq(withoutConfirmation), res as unknown as ResLike);

    expect(res._status).toBe(400);
    // Distinguishable from every other form error (which says "title, description and contact_raw…").
    expect(res._body.detail).toBe('no_worker_fee_confirmation_required');
    expect(inserts()).toHaveLength(0); // never stored as "false"
    expect(decideMock).not.toHaveBeenCalled(); // and not a single model token spent on it
  });

  it('an explicit false is refused the same way; so is a truthy impostor ("true", 1)', async () => {
    for (const value of [false, 'true', 1, null]) {
      h.state.queries = [];
      const res = makeRes();
      await adsCreate(makeReq({ ...body, no_worker_fee: value }), res as unknown as ResLike);
      expect(res._status, `no_worker_fee=${JSON.stringify(value)}`).toBe(400);
      expect(res._body.detail).toBe('no_worker_fee_confirmation_required');
      expect(inserts()).toHaveLength(0);
    }
  });

  it('with the confirmation the ad is created AND the confirmation is stamped server-side', async () => {
    const res = makeRes();

    await adsCreate(makeReq(body), res as unknown as ResLike);

    expect(res._status).toBe(200);
    const ins = inserts()[0]!;
    expect(ins.text).toContain('no_worker_fee_confirmed_at');
    // The moment is written by Postgres (now()), gated on the bound flag — not by a client value.
    expect(ins.text).toContain('case when ');
    expect(ins.text).toContain('then now() else null end');
    expect(ins.params[ins.params.length - 1]).toBe(true);
  });
});

describe('PATCH /api/ads/:id — an edit can neither lose nor withdraw the confirmation', () => {
  it('🔴 the edit UPDATE never mentions the confirmation column at all', async () => {
    const res = makeRes();

    await adItem(makeReq(body, 'PATCH', { id: AD_ID }), res as unknown as ResLike);

    expect(res._status).toBe(200);
    const upd = updates()[0]!;
    expect(upd, 'the handler reached the edit UPDATE').toBeTruthy();
    // ONE writer, ever: the create. If anybody adds the column to this SET list, this reddens —
    // and that is the point, because an author must not be able to retract a confirmation (or lose
    // it) by editing the text of an ad that is already published.
    expect(upd.text).not.toContain('no_worker_fee_confirmed_at');
  });

  it('an edit WITHOUT the checkbox in the body still succeeds (the stored confirmation stands)', async () => {
    const res = makeRes();
    const { no_worker_fee: _omitted, ...withoutConfirmation } = body;

    await adItem(makeReq(withoutConfirmation, 'PATCH', { id: AD_ID }), res as unknown as ResLike);

    // The confirmation was given once, at creation, and lives in the row — re-asking on every save
    // would turn one legal fact into a chore the author can fail by accident.
    expect(res._status).toBe(200);
    expect(updates()[0]!.text).not.toContain('no_worker_fee_confirmed_at');
  });
});
