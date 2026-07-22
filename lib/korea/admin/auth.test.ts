// lib/korea/admin/auth.test.ts
//
// requireAdmin is the single admin gate in front of the privileged WEB handlers
// (vacancies/moderate.ts takedown, ads/rw.ts moderate). It accepts TWO proofs, in order:
//   1) Bearer CRON_SECRET (server-to-server / owner tooling) — short-circuits before any DB;
//   2) a valid Mini App initData whose telegram_id is a recognised admin.
//
// This suite pins the fix that unified proof (2) with the gate the BOT already trusts:
// isAdminTelegram = env ADMIN_TELEGRAM_IDS ∪ users.role='admin'. Before the fix an admin
// recognised only by DB role got 401 on these web routes (env-only check). The two web
// consumers call requireAdmin(req) with ONE arg, so the signature is unchanged — these
// tests drive requireAdmin directly and map its AdminResult the way the handlers do
// (ok:false → Unauthorized/401, ok:true → the route proceeds/200).
//
// CRITICAL: fail-closed. isAdminTelegram swallows a role-lookup DB error to `false`, so a
// DB hiccup during the role check resolves to { ok:false } (401) — never a grant. The last
// test locks that in with a rejecting fake sql.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// getSql + authenticate are the only DB/identity edges requireAdmin touches; mock them so
// the suite runs with no Neon and no real initData. http.js (bearer/constant-time compare)
// is REAL — the bearer path is exercised end-to-end against process.env.CRON_SECRET.
vi.mock('../core/db.js', () => ({ getSql: vi.fn() }));
vi.mock('../core/context.js', () => ({ authenticate: vi.fn() }));

import type { ReqLike } from '../core/http.js';
import { getSql } from '../core/db.js';
import { authenticate } from '../core/context.js';
import { requireAdmin } from './auth.js';

type Row = Record<string, unknown>;

const ORIG_ADMIN_IDS = process.env.ADMIN_TELEGRAM_IDS;
const ORIG_CRON = process.env.CRON_SECRET;

/** Fake sql whose ONLY query (isAdminTelegram's `select exists(...role='admin') as ok`)
 *  resolves to the given existence flag. Records calls so a test can assert it ran (or not). */
function makeSql(existsOk: boolean) {
  const calls: { text: string; params: unknown[] }[] = [];
  const fn = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<Row[]> => {
    const text = Array.isArray(strings) ? (strings as unknown as string[]).join('?') : String(strings);
    calls.push({ text, params });
    return Promise.resolve([{ ok: existsOk }]);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { fn: fn as any, calls };
}

/** Fake sql that REJECTS — simulates a role-lookup DB fault (the fail-closed case). */
function makeThrowingSql() {
  const calls: { text: string; params: unknown[] }[] = [];
  const fn = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<Row[]> => {
    const text = Array.isArray(strings) ? (strings as unknown as string[]).join('?') : String(strings);
    calls.push({ text, params });
    return Promise.reject(new Error('db down'));
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { fn: fn as any, calls };
}

function makeReq(authorization?: string): ReqLike {
  return { method: 'POST', headers: authorization ? { authorization } : {}, query: {} };
}

/** A successful authenticate() result carrying the given telegram_id (the trusted id). */
const authedAs = (telegramId: string) =>
  ({ ok: true, user: { id: 'u1', telegramId, publicId: 'pub', lang: 'ru', allowsWriteToPm: false, isBlocked: false } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  // Clean baseline: no env admins, no cron secret unless a test opts in.
  delete process.env.ADMIN_TELEGRAM_IDS;
  delete process.env.CRON_SECRET;
});

afterAll(() => {
  if (ORIG_ADMIN_IDS === undefined) delete process.env.ADMIN_TELEGRAM_IDS;
  else process.env.ADMIN_TELEGRAM_IDS = ORIG_ADMIN_IDS;
  if (ORIG_CRON === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIG_CRON;
});

describe('requireAdmin — unified admin gate (env ∪ DB role), fail-closed', () => {
  it('non-admin: valid initData, not in env, role != admin → NOT admin (→ 401)', async () => {
    process.env.ADMIN_TELEGRAM_IDS = ''; // no env admins
    vi.mocked(authenticate).mockResolvedValue(authedAs('111'));
    const { fn, calls } = makeSql(false); // no users row with role='admin'
    vi.mocked(getSql).mockReturnValue(fn);

    const res = await requireAdmin(makeReq('tma someInitData'));
    expect(res.ok).toBe(false);
    // The role lookup actually ran and found nothing.
    expect(calls.some((c) => /role = 'admin'/.test(c.text))).toBe(true);
  });

  it('env admin (telegram_id in ADMIN_TELEGRAM_IDS) → admin, WITHOUT touching the DB', async () => {
    process.env.ADMIN_TELEGRAM_IDS = '222,999';
    vi.mocked(authenticate).mockResolvedValue(authedAs('222'));
    const { fn, calls } = makeSql(false); // DB would say "no", but env short-circuits first
    vi.mocked(getSql).mockReturnValue(fn);

    const res = await requireAdmin(makeReq('tma someInitData'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.via).toBe('user');
    // Env membership short-circuits: no role SELECT is issued.
    expect(calls).toHaveLength(0);
  });

  it('DB-role admin (users.role=admin, NOT in env) → admin (this is the FIX; was 401 before)', async () => {
    process.env.ADMIN_TELEGRAM_IDS = ''; // deliberately NOT listed in env
    vi.mocked(authenticate).mockResolvedValue(authedAs('333'));
    const { fn, calls } = makeSql(true); // users row with role='admin' exists
    vi.mocked(getSql).mockReturnValue(fn);

    const res = await requireAdmin(makeReq('tma someInitData'));
    expect(res.ok).toBe(true);
    if (res.ok && res.via === 'user') {
      expect(res.user.telegramId).toBe('333');
    } else {
      expect.fail('expected admin via user');
    }
    // Proof came from the DB role lookup, bound to the trusted id (never the body).
    const lookup = calls.find((c) => /role = 'admin'/.test(c.text));
    expect(lookup).toBeTruthy();
    expect(lookup!.params).toContain('333');
  });

  it('Bearer CRON_SECRET → admin via bearer, short-circuiting BEFORE authenticate/DB', async () => {
    process.env.CRON_SECRET = 'cron-secret-value';
    const { fn } = makeSql(false);
    vi.mocked(getSql).mockReturnValue(fn);

    const res = await requireAdmin(makeReq('Bearer cron-secret-value'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.via).toBe('bearer');
    // Bearer wins first: no initData verification, no DB role lookup.
    expect(vi.mocked(authenticate)).not.toHaveBeenCalled();
  });

  it('a WRONG bearer does not pass and falls through to the (non-admin) initData path → 401', async () => {
    process.env.CRON_SECRET = 'cron-secret-value';
    process.env.ADMIN_TELEGRAM_IDS = '';
    vi.mocked(authenticate).mockResolvedValue({ ok: false } as never);
    const { fn } = makeSql(false);
    vi.mocked(getSql).mockReturnValue(fn);

    const res = await requireAdmin(makeReq('Bearer WRONG-secret'));
    expect(res.ok).toBe(false);
    expect(vi.mocked(authenticate)).toHaveBeenCalledTimes(1); // fell through to initData
  });

  it('broken / expired initData (authenticate fails) → NOT admin (→ 401), no role lookup', async () => {
    process.env.ADMIN_TELEGRAM_IDS = '';
    vi.mocked(authenticate).mockResolvedValue({ ok: false } as never);
    const { fn, calls } = makeSql(true); // even if DB would say "admin", we never get there
    vi.mocked(getSql).mockReturnValue(fn);

    const res = await requireAdmin(makeReq('tma expiredInitData'));
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0); // unauthenticated → no DB touch
  });

  it('FAIL-CLOSED: a role-lookup DB error resolves to NOT admin (→ 401), never a grant', async () => {
    process.env.ADMIN_TELEGRAM_IDS = ''; // not an env admin, so the DB path is taken
    vi.mocked(authenticate).mockResolvedValue(authedAs('444'));
    const { fn, calls } = makeThrowingSql();
    vi.mocked(getSql).mockReturnValue(fn);

    // Must RESOLVE (not throw) to a denial — a DB hiccup must not open admin.
    const res = await requireAdmin(makeReq('tma someInitData'));
    expect(res.ok).toBe(false);
    expect(calls.length).toBe(1); // the failing role lookup was attempted
  });
});
