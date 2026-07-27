// lib/korea/admin/erase.test.ts
//
// POST /api/admin/erase-user — the tool behind «выполняем просьбу об удалении в течение 3 рабочих
// дней». DB-free: a fake tagged-template `sql` plays the users lookup and the shared eraseUsers()
// statements, so the properties the promise (and the referral economy) rest on are pinned here:
//
//   * closed to everyone but an admin;
//   * the ONLY identifier is telegram_id — the number Telegram itself put in the forwarded
//     «Написали в бот» DM. A @username is refused (handles change hands) and so is public_id: the
//     referral code is PUBLISHED by its owner in their invite link, so accepting it would let
//     anyone who saw that link have a stranger's account erased «без лишних вопросов»;
//   * it runs the SHARED erasure (the users row is stripped, never DELETEd, so no inviter's
//     ledger cascades away);
//   * a person who only ever wrote to the bot (no account) still gets their telegram-id ledgers
//     cleared;
//   * an admin account can never be erased — decided from the ROW that was resolved, and by all
//     three things auth.ts calls "admin" (env list, the caller himself, users.role);
//   * dry_run writes nothing;
//   * the response carries counts only — no name, no phone, no text.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    calls: [] as { text: string; params: unknown[] }[],
    /** Row the users lookup returns ([] = nobody). */
    userRows: [] as unknown[],
    admin: { ok: true, via: 'bearer' } as unknown,
    envAdminIds: [] as string[],
  };
  const fakeSql = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<unknown[]> => {
    const text = typeof strings === 'string' ? strings : strings.join(' ? ');
    state.calls.push({ text: text.replace(/\s+/g, ' ').trim(), params });
    if (/from users\s+where/.test(text.replace(/\s+/g, ' '))) return Promise.resolve(state.userRows);
    if (/update users set/.test(text)) return Promise.resolve([{ n: 1 }]);
    if (/delete from/.test(text)) return Promise.resolve([{ n: 2 }]);
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('./auth.js', () => ({
  requireAdmin: async () => h.state.admin,
  isAdminTelegramId: (id: string | number) => h.state.envAdminIds.includes(String(id)),
}));

import { adminEraseUser, normalizeTelegramId } from './erase.js';
import type { ReqLike, ResLike } from '../core/http.js';

const U1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

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

const deletesOn = (table: string) =>
  h.state.calls.filter((c) => new RegExp(`delete from ${table}\\b`).test(c.text));
const stamps = () => h.state.calls.filter((c) => /update users set/.test(c.text));

beforeEach(() => {
  h.state.calls = [];
  h.state.userRows = [];
  h.state.admin = { ok: true, via: 'bearer' };
  h.state.envAdminIds = [];
});

// ─────────────────────────────────────────────────────────────────────────────
// Input normalization (pure)
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeTelegramId — only a real numeric id', () => {
  it('accepts a number or a digit string (what the owner copies from the DM)', () => {
    expect(normalizeTelegramId(555)).toBe('555');
    expect(normalizeTelegramId('555')).toBe('555');
    expect(normalizeTelegramId('  7654321  ')).toBe('7654321');
  });
  it('refuses a username, a decorated id or nonsense', () => {
    expect(normalizeTelegramId('@ivanp')).toBeNull();
    expect(normalizeTelegramId('id 555')).toBeNull();
    expect(normalizeTelegramId('0')).toBeNull();
    expect(normalizeTelegramId('-5')).toBeNull();
    expect(normalizeTelegramId('12345678901234567890')).toBeNull(); // past bigint
    expect(normalizeTelegramId(undefined)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('adminEraseUser — the gate', () => {
  it('401 without admin proof, and NOTHING is touched', async () => {
    h.state.admin = { ok: false };
    const res = makeRes();
    await adminEraseUser(makeReq({ telegram_id: '555' }), res);

    expect(res._status).toBe(401);
    expect(h.state.calls).toHaveLength(0);
  });

  it('404 on a non-POST method', async () => {
    const res = makeRes();
    await adminEraseUser(makeReq({ telegram_id: '555' }, 'GET'), res);
    expect(res._status).toBe(404);
  });

  it('400 without an identifier, and the detail says which one to send', async () => {
    const res = makeRes();
    await adminEraseUser(makeReq({}), res);

    expect(res._status).toBe(400);
    expect(res._body.detail).toContain('telegram_id');
    expect(h.state.calls).toHaveLength(0);
  });

  it('refuses a @username outright (a handle can be re-registered by another person)', async () => {
    const res = makeRes();
    await adminEraseUser(makeReq({ telegram_id: '@ivanp' }), res);
    expect(res._status).toBe(400);
    expect(h.state.calls).toHaveLength(0);
  });
});

// The referral code is not a secret: its owner publishes it in their own invite link
// (?startapp=<code>). If the endpoint took it, «удалите мои данные, мой код X» quoting a link seen
// in a chat would irreversibly erase a STRANGER — and the Policy promises to comply without
// questions. So the field is refused, loudly, and it never reaches the database.
describe('adminEraseUser — public_id is NOT an identifier', () => {
  it('400 when public_id is the only thing sent, and nothing is looked up', async () => {
    const res = makeRes();
    await adminEraseUser(makeReq({ public_id: 'a1b2c3d4e5f60718' }), res);

    expect(res._status).toBe(400);
    expect(res._body.detail).toContain('public_id');
    expect(res._body.detail).toContain('telegram_id'); // says what to send instead
    expect(h.state.calls).toHaveLength(0);
  });

  it('400 even alongside a valid telegram_id — the stale field is never silently ignored', async () => {
    h.state.userRows = [{ id: U1, tid: '555', role: 'user' }];
    const res = makeRes();

    await adminEraseUser(makeReq({ telegram_id: '555', public_id: 'a1b2c3d4e5f60718' }), res);

    expect(res._status).toBe(400);
    expect(h.state.calls).toHaveLength(0);
    expect(stamps()).toHaveLength(0);
  });

  it('400 for a malformed public_id too (the field itself is gone, not just its format)', async () => {
    const res = makeRes();
    await adminEraseUser(makeReq({ public_id: 'zzz' }), res);

    expect(res._status).toBe(400);
    expect(h.state.calls).toHaveLength(0);
  });
});

describe('adminEraseUser — erasing an account', () => {
  it('runs the SHARED erasure: dependents deleted, users row stripped, never DELETEd', async () => {
    h.state.userRows = [{ id: U1, tid: '555', role: 'user' }];
    const res = makeRes();

    await adminEraseUser(makeReq({ telegram_id: '555' }), res);

    expect(res._status).toBe(200);
    expect(res._body.found).toBe(true);
    expect(res._body.counts.usersErased).toBe(1);
    // The dangerous shortcut is not taken, and the inviter's anchor rows stay put.
    expect(h.state.calls.filter((c) => /delete from users\b/.test(c.text))).toHaveLength(0);
    expect(deletesOn('referral_activations')).toHaveLength(0);
    // Their own data is gone, including both telegram-id ledgers.
    expect(deletesOn('subscriptions')).toHaveLength(1);
    expect(deletesOn('user_ads')).toHaveLength(1);
    expect(deletesOn('bot_updates')).toHaveLength(1);
    expect(deletesOn('bot_inbox')).toHaveLength(1);
    expect(stamps()).toHaveLength(1);
  });

  it('looks the person up by telegram_id among LIVE accounts only (idempotent re-run)', async () => {
    h.state.userRows = [{ id: U1, tid: '555', role: 'user' }];
    await adminEraseUser(makeReq({ telegram_id: '555' }), makeRes());

    const lookup = h.state.calls[0]!;
    expect(lookup.text).toMatch(/telegram_id = \? ?::bigint/);
    expect(lookup.text).toContain('deleted_at is null');
    expect(lookup.params[0]).toBe('555');
  });

  it('has exactly ONE way into the users table — no lookup is ever made on public_id', async () => {
    h.state.userRows = [{ id: U1, tid: '555', role: 'user' }];
    await adminEraseUser(makeReq({ telegram_id: '555' }), makeRes());

    const lookups = h.state.calls.filter((c) => /from users\s+where/.test(c.text));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.text).toMatch(/where telegram_id = \?/);
    // The only other statement that mentions public_id is the erasure itself (it re-randomizes
    // the code); nobody is ever FOUND by it.
    expect(lookups[0]!.text).not.toContain('public_id');
  });

  it('the response says only HOW MUCH was erased — no name, phone or message text', async () => {
    h.state.userRows = [{ id: U1, tid: '555', role: 'user' }];
    const res = makeRes();
    await adminEraseUser(makeReq({ telegram_id: '555' }), res);

    expect(JSON.stringify(res._body)).not.toContain(U1);
    expect(Object.keys(res._body)).toEqual(['ok', 'found', 'counts']);
  });
});

describe('adminEraseUser — a person who never opened the app', () => {
  it('still clears the bot ledgers keyed on their telegram id and says found:false', async () => {
    h.state.userRows = []; // no account at all
    const res = makeRes();

    await adminEraseUser(makeReq({ telegram_id: '555' }), res);

    expect(res._status).toBe(200);
    expect(res._body.found).toBe(false);
    expect(deletesOn('bot_updates')[0]!.params[0]).toEqual(['555']);
    expect(deletesOn('bot_inbox')[0]!.params[0]).toEqual(['555']);
    // Nothing account-shaped was touched.
    expect(stamps()).toHaveLength(0);
    expect(deletesOn('subscriptions')).toHaveLength(0);
  });

});

describe('adminEraseUser — refusals that protect the owner', () => {
  it('never erases an account whose DB role is admin', async () => {
    h.state.userRows = [{ id: U1, tid: '555', role: 'admin' }];
    const res = makeRes();

    await adminEraseUser(makeReq({ telegram_id: '555' }), res);

    expect(res._status).toBe(400);
    expect(stamps()).toHaveLength(0);
  });

  it('never erases an id listed in ADMIN_TELEGRAM_IDS (refused before any DB read)', async () => {
    h.state.envAdminIds = ['555'];
    const res = makeRes();

    await adminEraseUser(makeReq({ telegram_id: '555' }), res);

    expect(res._status).toBe(400);
    expect(h.state.calls).toHaveLength(0);
  });

  it('never erases the admin who is making the call', async () => {
    h.state.admin = {
      ok: true,
      via: 'user',
      user: { id: 'x', telegramId: '555', publicId: 'p', lang: 'ru', allowsWriteToPm: true, isBlocked: false },
    };
    const res = makeRes();

    await adminEraseUser(makeReq({ telegram_id: '555' }), res);

    expect(res._status).toBe(400);
    expect(h.state.calls).toHaveLength(0);
  });

  // The two tests below pin the refusal to the ROW the lookup returned, not to the id that was
  // typed. They deliberately hand back a row whose telegram id differs from the requested one —
  // impossible through today's single lookup, and that is the point: if anyone ever adds a second
  // way to find the person, the admin guarantee must already cover it. Checking only role='admin'
  // there would NOT: auth.ts treats ADMIN_TELEGRAM_IDS and users.role='admin' as two independent
  // lists, so an env admin can legitimately carry role='user' in the database.
  it('refuses when the RESOLVED row belongs to an ADMIN_TELEGRAM_IDS id whose DB role is "user"', async () => {
    h.state.envAdminIds = ['777'];
    h.state.userRows = [{ id: U1, tid: '777', role: 'user' }];
    const res = makeRes();

    await adminEraseUser(makeReq({ telegram_id: '556' }), res);

    expect(res._status).toBe(400);
    expect(res._body.detail).toBe('admin account');
    expect(stamps()).toHaveLength(0);
    expect(deletesOn('bot_inbox')).toHaveLength(0);
  });

  it('refuses when the RESOLVED row is the calling admin himself (self-erasure)', async () => {
    h.state.admin = {
      ok: true,
      via: 'user',
      user: { id: 'x', telegramId: '777', publicId: 'p', lang: 'ru', allowsWriteToPm: true, isBlocked: false },
    };
    h.state.userRows = [{ id: U1, tid: '777', role: 'user' }];
    const res = makeRes();

    await adminEraseUser(makeReq({ telegram_id: '556' }), res);

    expect(res._status).toBe(400);
    expect(stamps()).toHaveLength(0);
  });
});

describe('adminEraseUser — dry run', () => {
  it('reports whether the person exists and writes NOTHING', async () => {
    h.state.userRows = [{ id: U1, tid: '555', role: 'user' }];
    const res = makeRes();

    await adminEraseUser(makeReq({ telegram_id: '555', dry_run: true }), res);

    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ dryRun: true, found: true });
    expect(res._body.counts.usersErased).toBe(0);
    // Exactly one statement: the lookup.
    expect(h.state.calls).toHaveLength(1);
    expect(stamps()).toHaveLength(0);
  });
});
