// lib/korea/admin/takedown.test.ts
//
// POST /api/admin/takedown-contact — the path for a person who is NOT in our database: an employer
// whose phone we picked up from a foreign Telegram chat and who writes «уберите мой номер».
// DB-free (a fake tagged-template `sql`), so what is pinned here is the behaviour the Privacy
// Policy promise depends on:
//
//   * admin-only;
//   * the owner may paste what he actually has — a phone, a @handle, a card UUID or a share link;
//   * the contact key comes from kj_normalize_contact, the SAME function that generates
//     vacancies.contact_normalized, so "010-1234-5678" and "+821012345678" cannot miss each other;
//   * a named card ALSO pulls in every other card with the same contact (that is what «уберите мой
//     номер» means);
//   * the takedown record is written BEFORE the cards go dark, so the block survives a half-done
//     run (cleanup re-enforces it) and a repost cannot resurrect the content;
//   * user ads carrying the same contact are taken down too;
//   * dry_run only counts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    calls: [] as { text: string; params: unknown[] }[],
    norm: '821012345678' as string | null,
    vacancyRows: [{ contact_normalized: '821012345678' }] as unknown[],
    recorded: [{ id: 't1' }, { id: 't2' }] as unknown[],
    deactivated: [{ id: 'v1' }] as unknown[],
    adsTakenDown: [{ id: 'a1' }] as unknown[],
    dryCounts: [{ total: 3, active: 2 }] as unknown[],
    dryAds: [{ total: 1 }] as unknown[],
    admin: { ok: true, via: 'bearer' } as unknown,
  };
  const fakeSql = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<unknown[]> => {
    const raw = typeof strings === 'string' ? strings : strings.join(' ? ');
    const text = raw.replace(/\s+/g, ' ').trim();
    state.calls.push({ text, params });
    if (/^select kj_normalize_contact/.test(text)) return Promise.resolve([{ norm: state.norm }]);
    if (/select contact_normalized from vacancies/.test(text)) return Promise.resolve(state.vacancyRows);
    if (/as total, \(count\(\*\) filter/.test(text)) return Promise.resolve(state.dryCounts);
    if (/count\(\*\)::int as total from user_ads/.test(text)) return Promise.resolve(state.dryAds);
    if (/insert into takedowns/.test(text)) return Promise.resolve(state.recorded);
    if (/update vacancies set is_active = false/.test(text)) return Promise.resolve(state.deactivated);
    if (/update user_ads set status/.test(text)) return Promise.resolve(state.adsTakenDown);
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('./auth.js', () => ({ requireAdmin: async () => h.state.admin }));

import { contactTakedown, parseVacancyRef } from './takedown.js';
import type { ReqLike, ResLike } from '../core/http.js';

const VAC = '0f8c2a1b-3d4e-4f5a-6b7c-8d9e0f1a2b3c';

function makeReq(body: unknown, method = 'POST'): ReqLike {
  return { method, headers: { authorization: 'Bearer stub' }, body };
}
function makeRes(): ResLike & { _status: number; _body: any } {
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

const find = (re: RegExp) => h.state.calls.find((c) => re.test(c.text));

beforeEach(() => {
  h.state.calls = [];
  h.state.norm = '821012345678';
  h.state.vacancyRows = [{ contact_normalized: '821012345678' }];
  h.state.recorded = [{ id: 't1' }, { id: 't2' }];
  h.state.deactivated = [{ id: 'v1' }];
  h.state.adsTakenDown = [{ id: 'a1' }];
  h.state.admin = { ok: true, via: 'bearer' };
});

// ─────────────────────────────────────────────────────────────────────────────
// Reference parsing (pure) — the owner pastes whatever the person sent him
// ─────────────────────────────────────────────────────────────────────────────

describe('parseVacancyRef — a card reference in any shape the owner may have', () => {
  it('takes a dashed UUID as-is', () => {
    expect(parseVacancyRef(VAC)).toBe(VAC);
    expect(parseVacancyRef(`посмотрите вот это ${VAC.toUpperCase()} спасибо`)).toBe(VAC);
  });
  it('takes the share deep link (?startapp=v<32hex>r<ref>) and restores the dashes', () => {
    const link = `https://t.me/korea_rabota_bot/app?startapp=v${VAC.replace(/-/g, '')}ra1b2c3d4e5f60718`;
    expect(parseVacancyRef(link)).toBe(VAC);
  });
  it('takes the bare 32-hex form', () => {
    expect(parseVacancyRef(VAC.replace(/-/g, ''))).toBe(VAC);
  });
  it('returns null for anything that is not a card reference', () => {
    expect(parseVacancyRef('уберите мой номер')).toBeNull();
    expect(parseVacancyRef('')).toBeNull();
    expect(parseVacancyRef(undefined)).toBeNull();
    expect(parseVacancyRef(12345)).toBeNull();
  });
  it('is bounded like `contact` and `reason`: the regexes never scan an unbounded string', () => {
    // A reference inside the cap is still found…
    expect(parseVacancyRef(`${'a'.repeat(400)} ${VAC}`)).toBe(VAC);
    // …and a megabyte of padding cannot make the parser chew through it.
    expect(parseVacancyRef(`${'a'.repeat(100_000)} ${VAC}`)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('contactTakedown — the gate', () => {
  it('401 without admin proof and nothing is touched', async () => {
    h.state.admin = { ok: false };
    const res = makeRes();
    await contactTakedown(makeReq({ contact: '01012345678' }), res);

    expect(res._status).toBe(401);
    expect(h.state.calls).toHaveLength(0);
  });

  it('404 on a non-POST method', async () => {
    const res = makeRes();
    await contactTakedown(makeReq({ contact: '01012345678' }, 'GET'), res);
    expect(res._status).toBe(404);
  });

  it('400 when neither a contact nor a card is given', async () => {
    const res = makeRes();
    await contactTakedown(makeReq({}), res);
    expect(res._status).toBe(400);
    expect(h.state.calls).toHaveLength(0);
  });
});

describe('contactTakedown — by phone number (the usual request)', () => {
  it('normalizes through kj_normalize_contact, records the block, then darkens the cards', async () => {
    const res = makeRes();
    await contactTakedown(makeReq({ contact: '010-1234-5678' }), res);

    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({
      ok: true,
      contactMatched: true,
      takedownsRecorded: 2,
      vacanciesDeactivated: 1,
      adsTakenDown: 1,
    });

    // The key is derived by the SAME function that generates vacancies.contact_normalized.
    expect(h.state.calls[0]!.text).toMatch(/^select kj_normalize_contact/);
    expect(h.state.calls[0]!.params[0]).toBe('010-1234-5678');

    // ORDER: the takedown record is written BEFORE the cards are deactivated, so a half-done run
    // still blocks the content (and cleanup darkens it on the next tick).
    const iRecord = h.state.calls.findIndex((c) => /insert into takedowns/.test(c.text));
    const iDark = h.state.calls.findIndex((c) => /update vacancies set is_active = false/.test(c.text));
    expect(iRecord).toBeGreaterThan(-1);
    expect(iDark).toBeGreaterThan(iRecord);
  });

  it('records ONE row per distinct content_hash and never a duplicate', async () => {
    await contactTakedown(makeReq({ contact: '01012345678' }), makeRes());

    const ins = find(/insert into takedowns/)!;
    expect(ins.text).toContain('distinct on (v.content_hash)');
    expect(ins.text).toContain('not exists');
  });

  it('takes down user ads carrying the same contact', async () => {
    await contactTakedown(makeReq({ contact: '01012345678' }), makeRes());

    const ads = find(/update user_ads set status/)!;
    expect(ads.text).toContain("status = 'taken_down'");
    expect(ads.text).toContain("status <> 'taken_down'"); // idempotent
    expect(ads.text).toContain('kj_normalize_contact(contact_raw)');
  });

  it('a contact that normalizes to nothing touches no ads (and says so)', async () => {
    h.state.norm = null;
    const res = makeRes();

    await contactTakedown(makeReq({ contact: 'просто текст' }), res);

    expect(res._status).toBe(200);
    expect(res._body.contactMatched).toBe(false);
    expect(res._body.adsTakenDown).toBe(0);
    expect(find(/update user_ads set status/)).toBeUndefined();
  });
});

describe('contactTakedown — by card reference', () => {
  it('uses the card’s own contact, so every OTHER card with that number goes too', async () => {
    const res = makeRes();
    await contactTakedown(makeReq({ vacancy: VAC }), res);

    expect(res._status).toBe(200);
    expect(res._body.vacancyFound).toBe(true);
    // The set is "this card OR anything with its contact".
    const dark = find(/update vacancies set is_active = false/)!;
    expect(dark.text).toContain('contact_normalized = ?');
    expect(dark.text).toContain('id = ?');
    expect(dark.params).toContain('821012345678');
    expect(dark.params).toContain(VAC);
  });

  it('404 when the card does not exist (a mistyped link must not silently do nothing)', async () => {
    h.state.vacancyRows = [];
    const res = makeRes();

    await contactTakedown(makeReq({ vacancy: VAC }), res);

    expect(res._status).toBe(404);
    expect(find(/insert into takedowns/)).toBeUndefined();
  });

  it('a contact-less card is still taken down on its own', async () => {
    h.state.vacancyRows = [{ contact_normalized: null }];
    const res = makeRes();

    await contactTakedown(makeReq({ vacancy: VAC }), res);

    expect(res._status).toBe(200);
    expect(res._body.contactMatched).toBe(false);
    expect(find(/update vacancies set is_active = false/)!.params).toContain(VAC);
  });
});

describe('contactTakedown — dry run (see the blast radius first)', () => {
  it('counts what would be affected and writes nothing', async () => {
    const res = makeRes();
    await contactTakedown(makeReq({ contact: '01012345678', dry_run: true }), res);

    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({
      dryRun: true,
      wouldAffect: { vacancies: 3, activeVacancies: 2, ads: 1 },
    });
    expect(find(/insert into takedowns/)).toBeUndefined();
    expect(find(/update vacancies set is_active = false/)).toBeUndefined();
    expect(find(/update user_ads set status/)).toBeUndefined();
  });
});
