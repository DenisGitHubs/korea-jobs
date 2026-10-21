// lib/korea/reports/rw.test.ts
//
// POST /api/vacancies/:id/report — the USER AD branch (2026-10-21, Законник + owner).
//
// 🔴 WHY THESE TESTS GO THROUGH THE HANDLER AND NEVER CALL revokeFeaturedOnReport DIRECTLY.
// A function with a green test of its own that NOBODY CALLS is exactly the defect class this
// project has already paid for (seven dead spam-filter rules that fired for nobody, for months).
// So the proof that "the first complaint takes the lift" is alive runs through the very handle a
// person's tap reaches — remove the call in reports/rw.ts and these tests go red.
//
// The fake `sql` records every statement; what it cannot do is evaluate a WHERE clause, so where
// the rule IS a WHERE clause it is asserted as SQL text (same reasoning as notify/run.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    queries: [] as { text: string; params: unknown[] }[],
    sent: [] as { chatId: string; text: string }[],
    /** Is the id a scraped vacancy? (false = the report must fall through to the ad branch.) */
    isVacancy: false,
    /** Does the id resolve to a user ad at all? */
    isAd: true,
    /** Did this user already report this ad? */
    already: false,
    /** How many reports this user made in the last 24h (the cap is 20 by default). */
    used: 0,
    /** Did the INSERT actually create a row (0 = lost a race on the unique index)? */
    inserted: 1,
    /** Did the ad really carry a LIVE lift (1 = the revoke UPDATE matched a row)? */
    liftWasLive: 1,
  };
  const fakeSql = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<unknown[]> => {
    const text = typeof strings === 'string' ? strings : strings.join(' ? ');
    state.queries.push({ text, params });
    if (/from vacancies v/.test(text)) {
      return Promise.resolve(
        state.isVacancy ? [{ title: 'Скрапнутая вакансия', description: null, work_type: 'factory', city_name: { ru: 'Сеул' } }] : [],
      );
    }
    if (/from user_ads a/.test(text)) {
      return Promise.resolve(
        state.isAd
          ? [
              {
                // A real ad text often carries a phone number — it must never reach the DM or a log.
                title: 'Упаковка, звоните 010-1234-5678',
                description: 'Нужны люди на упаковку, 010-1234-5678',
                work_type: 'factory',
                city_name: { ru: 'Ансан' },
              },
            ]
          : [],
      );
    }
    if (/select 1 from ad_reports/.test(text)) return Promise.resolve(state.already ? [{ one: 1 }] : []);
    if (/from ad_reports\s+where user_id/.test(text)) return Promise.resolve([{ c: state.used }]);
    if (/insert into ad_reports/.test(text)) return Promise.resolve(state.inserted > 0 ? [{ one: 1 }] : []);
    if (/update user_ads set featured_until/.test(text)) {
      return Promise.resolve(state.liftWasLive > 0 ? [{ id: 'ad' }] : []);
    }
    if (/from ad_reports where user_ad_id/.test(text)) return Promise.resolve([{ c: 1 }]);
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('../core/context.js', () => ({
  authenticate: async () => ({
    ok: true,
    user: { id: '00000000-0000-0000-0000-000000000001', telegramId: '555000111', publicId: 'abc', lang: 'ru', allowsWriteToPm: true, isBlocked: false },
  }),
}));
vi.mock('../config.js', () => ({
  getConfigNumber: async (_k: string, fb: number) => fb,
  getConfigBool: async (_k: string, fb: boolean) => fb,
  getConfigString: async (_k: string, fb: string) => fb,
}));
vi.mock('../bot/telegram.js', () => ({
  sendMessage: async (chatId: string, text: string) => {
    h.state.sent.push({ chatId: String(chatId), text });
    return { ok: true };
  },
}));
vi.mock('../admin/auth.js', () => ({ adminRecipients: async () => ['777000999'] }));

import { vacancyReport } from './rw.js';
import type { ReqLike, ResLike } from '../core/http.js';

const AD_ID = '22222222-2222-2222-2222-222222222222';

function makeReq(id: string, reason: string | null = 'берут деньги с рабочих'): ReqLike {
  return { method: 'POST', headers: { authorization: 'tma stub' }, body: { reason }, query: { id } };
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

const revokes = () => h.state.queries.filter((q) => /update user_ads set featured_until/.test(q.text));
const adInserts = () => h.state.queries.filter((q) => /insert into ad_reports/.test(q.text));

beforeEach(() => {
  h.state.queries = [];
  h.state.sent = [];
  h.state.isVacancy = false;
  h.state.isAd = true;
  h.state.already = false;
  h.state.used = 0;
  h.state.inserted = 1;
  h.state.liftWasLive = 1;
});

describe('a complaint about a USER AD is recorded (it used to answer 404)', () => {
  it('stores it in ad_reports, bound to the caller and the ad, and answers 200', async () => {
    const res = makeRes();
    await vacancyReport(makeReq(AD_ID), res as unknown as ResLike);

    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ ok: true });
    const ins = adInserts()[0]!;
    expect(ins, 'the ad branch reached the INSERT').toBeTruthy();
    expect(ins.params[0]).toBe('00000000-0000-0000-0000-000000000001'); // the caller, from initData
    expect(ins.params[1]).toBe(AD_ID);
    expect(ins.text).toContain('on conflict (user_id, user_ad_id) do nothing'); // race-safe
  });

  it('an id that is neither a vacancy nor an ad is still a 404', async () => {
    h.state.isAd = false;
    const res = makeRes();
    await vacancyReport(makeReq(AD_ID), res as unknown as ResLike);

    expect(res._status).toBe(404);
    expect(adInserts()).toHaveLength(0);
    expect(revokes()).toHaveLength(0);
  });
});

describe('🔴 the FIRST complaint takes the LIFT, not the AD', () => {
  it('revokes the featured lift through the very handle a person taps', async () => {
    const res = makeRes();
    await vacancyReport(makeReq(AD_ID), res as unknown as ResLike);

    // If the call in reports/rw.ts is removed, this is the line that reddens.
    expect(revokes()).toHaveLength(1);
    expect(revokes()[0]!.text).toContain('featured_until = now()');
  });

  it('leaves the AD live and visible: nothing touches its status, expiry or visibility', async () => {
    const res = makeRes();
    await vacancyReport(makeReq(AD_ID), res as unknown as ResLike);

    expect(res._status).toBe(200);
    const writes = h.state.queries.filter((q) => /^\s*(update|delete)/i.test(q.text.trim()));
    // The ONLY write to user_ads is the one that ends the week.
    expect(writes).toHaveLength(1);
    expect(writes[0]!.text).toContain('featured_until');
    expect(writes[0]!.text).not.toContain('status');
    expect(writes[0]!.text).not.toContain('expires_at');
  });

  it('a repeat complaint from the same person changes nothing (no insert, no second revoke)', async () => {
    h.state.already = true;
    const res = makeRes();
    await vacancyReport(makeReq(AD_ID), res as unknown as ResLike);

    expect(res._status).toBe(200);
    expect(adInserts()).toHaveLength(0);
    expect(revokes()).toHaveLength(0);
    expect(h.state.sent).toHaveLength(0); // and the admin is not DMed twice about one person
  });

  it('a lost race on the unique index does not revoke or DM twice', async () => {
    h.state.inserted = 0;
    const res = makeRes();
    await vacancyReport(makeReq(AD_ID), res as unknown as ResLike);

    expect(res._status).toBe(200);
    expect(revokes()).toHaveLength(0);
    expect(h.state.sent).toHaveLength(0);
  });

  it('the per-person daily cap still applies (429, nothing written)', async () => {
    h.state.used = 20; // report_daily_cap default
    const res = makeRes();
    await vacancyReport(makeReq(AD_ID), res as unknown as ResLike);

    expect(res._status).toBe(429);
    expect(adInserts()).toHaveLength(0);
    expect(revokes()).toHaveLength(0);
  });
});

describe('the admin DM: what it says, and what it must never contain', () => {
  it('tells the admin the lift is gone and the ad is still in the feed', async () => {
    const res = makeRes();
    await vacancyReport(makeReq(AD_ID), res as unknown as ResLike);

    expect(h.state.sent).toHaveLength(1);
    const msg = h.state.sent[0]!.text;
    expect(msg).toContain('Жалоба на объявление');
    expect(msg).toContain('Подъём в верх ленты снят автоматически');
    expect(msg).toContain('осталось в ленте');
  });

  it('says so differently when there was no lift to take', async () => {
    h.state.liftWasLive = 0;
    const res = makeRes();
    await vacancyReport(makeReq(AD_ID), res as unknown as ResLike);

    const msg = h.state.sent[0]!.text;
    expect(msg).not.toContain('Подъём в верх ленты снят');
    expect(msg).toContain('осталось в ленте');
  });

  it('🔴 no contact from the ad text and no telegram id of the reporter anywhere in the message', async () => {
    const res = makeRes();
    await vacancyReport(makeReq(AD_ID), res as unknown as ResLike);

    const msg = h.state.sent[0]!.text;
    expect(msg).not.toContain('010-1234-5678'); // scrubbed, even though the ad's title carries it
    expect(msg).not.toContain('555000111'); // the reporter's telegram id is never mentioned
    expect(msg).not.toContain('00000000-0000-0000-0000-000000000001'); // nor their internal id
    // The DM goes to the admin's own chat id — that is a recipient, not content.
    expect(h.state.sent[0]!.chatId).toBe('777000999');
  });
});
