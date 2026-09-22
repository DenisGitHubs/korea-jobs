// lib/korea/auth/hub.test.ts
//
// The exchange window, driven THROUGH THE ROUTER (api/index.ts) rather than by calling the
// handler directly: a handler that exists but is not in the route table answers 404 while
// every test about it stays green (skill router-table-coverage.md). The front end already
// posts to /api/auth/hub, so the route is part of the contract, not an implementation
// detail.
//
// Nothing is mocked: real Ed25519 keys, real tickets signed by jose, a real pass verified
// by hub-session. The four numbers this door promises are pinned separately —
// 400 (shape), 401 (any ticket refusal), 🔴 503 (OUR key missing), 200 (the trade) — plus
// the rule that the machine reason NEVER leaves the server.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import router from '../../../api/index.js';
import type { ReqLike, ResLike } from '../core/http.js';
import { HUB_TICKET_AUDIENCE, HUB_TICKET_ISSUER, HUB_TICKET_PUBLIC_KEY_ENV } from '../core/hub-ticket.js';
import { verifyHubSession } from '../core/hub-session.js';

const BOT_TOKEN = '123456:AA_test_bot_token_for_unit_tests_only';

const hub = generateKeyPairSync('ed25519');
const HUB_PEM = hub.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const impostor = generateKeyPairSync('ed25519');

const nowSec = () => Math.floor(Date.now() / 1000);

/** Every machine reason the ticket verifier can produce — none may appear in an answer. */
const ALL_REASONS = [
  'not_configured', 'bad_form', 'bad_alg', 'bad_alg_late', 'bad_signature', 'expired',
  'issued_in_future', 'ttl_too_long', 'iss_mismatch', 'aud_mismatch', 'bad_sub', 'bad_jti',
  'bad_snapshot',
];

async function ticket(
  over: { sub?: string; aud?: string; iss?: string; iat?: number; exp?: number; key?: typeof hub.privateKey; snapshot?: unknown } = {},
): Promise<string> {
  const iat = over.iat ?? nowSec();
  const exp = over.exp ?? iat + 60;
  const body = over.snapshot === undefined ? {} : { snapshot: over.snapshot };
  return new SignJWT(body as Record<string, unknown>)
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setIssuer(over.iss ?? HUB_TICKET_ISSUER)
    .setAudience(over.aud ?? HUB_TICKET_AUDIENCE)
    .setSubject(over.sub ?? '555000111')
    .setJti(randomBytes(16).toString('base64url'))
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(over.key ?? hub.privateKey);
}

function makeRes() {
  return {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    setHeader(n: string, v: string) {
      this.headers[n] = v;
    },
    end(b: string) {
      this.body = b;
    },
  };
}

/** POST /api/auth/hub through the real router. */
async function call(body: unknown, method = 'POST') {
  const res = makeRes();
  await router(
    { method, headers: {}, body, query: { path: 'auth/hub' } } as ReqLike,
    res as unknown as ResLike,
  );
  return res;
}

beforeEach(() => {
  process.env[HUB_TICKET_PUBLIC_KEY_ENV] = HUB_PEM;
  process.env.BOT_TOKEN = BOT_TOKEN;
  // The door logs refusals and the successful jti; both are checked explicitly below, and
  // silenced elsewhere so the suite output stays readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env[HUB_TICKET_PUBLIC_KEY_ENV];
  vi.restoreAllMocks();
});

describe('POST /api/auth/hub — the route exists and trades a ticket for a pass', () => {
  it('200: a real ticket comes back as a pass that verifies, with its expiry', async () => {
    const res = await call({ hub_ticket: await ticket({ sub: '555000111', snapshot: { language: 'ru' } }) });

    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body) as { token: string; expires_at: number };
    expect(typeof out.token).toBe('string');
    expect(out.expires_at).toBeGreaterThan(nowSec());

    const v = verifyHubSession(out.token, BOT_TOKEN);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.sub).toBe('555000111');
      expect(v.claims.lang).toBe('ru');
      expect(v.claims.exp).toBe(out.expires_at);
    }
  });

  it('🔴 the 19-digit id reaches the pass as an EXACT string (no 2^53 rounding anywhere)', async () => {
    const big = '9007199254740993';
    const res = await call({ hub_ticket: await ticket({ sub: big }) });
    expect(res.statusCode).toBe(200);

    const { token } = JSON.parse(res.body) as { token: string };
    const v = verifyHubSession(token, BOT_TOKEN);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.claims.sub).toBe(big);
  });

  it('🔴 the pass CARRIES the jti of the ticket it was traded for (fix №2)', async () => {
    // Without this the success line `[auth/hub] ok jti=X` joins to nothing: two passes
    // minted from ONE replayed ticket are indistinguishable from each other and from an
    // honest login, so an incident cannot even be scoped. The ticket replay itself stays
    // an accepted risk — this is what makes it investigable.
    const t = await ticket({ sub: '555000111' });
    const jti = JSON.parse(Buffer.from(t.split('.')[1] as string, 'base64url').toString('utf8'))
      .jti as string;

    const res = await call({ hub_ticket: t });
    expect(res.statusCode).toBe(200);

    const v = verifyHubSession((JSON.parse(res.body) as { token: string }).token, BOT_TOKEN);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.claims.jti).toBe(jti);
  });

  it('🔴 a hub-signed ticket with a 700-character language tag is a 401, not a dead pass (fix №7)', async () => {
    // Signed by the REAL key, so nothing about it is forged: the tag was simply longer
    // than the pass could carry. Before the bound it answered 200 with a token that every
    // later request refused — the person saw a working login and then a broken app.
    const res = await call({
      hub_ticket: await ticket({ snapshot: { language: 'ru' + '-abcdefgh'.repeat(80) } }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('token');
  });

  it('logs the jti on success — and NOTHING else', async () => {
    const t = await ticket();
    const jti = JSON.parse(Buffer.from(t.split('.')[1] as string, 'base64url').toString('utf8')).jti;
    const spy = vi.spyOn(console, 'log');

    const res = await call({ hub_ticket: t });
    expect(res.statusCode).toBe(200);

    // Without a jti the log cannot tell a thief's login from the owner's — that is the whole
    // reason a successful login is logged at all.
    expect(spy).toHaveBeenCalledWith(`[auth/hub] ok jti=${jti}`);
    const printed = spy.mock.calls.flat().join(' ');
    expect(printed).not.toContain('555000111'); // no telegram_id
    expect(printed).not.toContain(t.slice(0, 32)); // no ticket
    expect(printed).not.toContain(JSON.parse(res.body).token.slice(0, 24)); // no pass
  });

  it('answers 404 to a GET — the window is POST-only', async () => {
    expect((await call({ hub_ticket: await ticket() }, 'GET')).statusCode).toBe(404);
  });
});

describe('POST /api/auth/hub — 400 is about the SHAPE of the request', () => {
  it('no body, no field, wrong type, or oversized -> 400', async () => {
    for (const body of [null, {}, { hub_ticket: null }, { hub_ticket: 42 }, { hub_ticket: '' }, { hub_ticket: { a: 1 } }, { hub_ticket: 'x'.repeat(4097) }]) {
      const res = await call(body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
  });

  it('a 400 never says anything about tickets in general', async () => {
    const res = await call({});
    const printed = res.body;
    for (const reason of ALL_REASONS) expect(printed).not.toContain(reason);
  });
});

describe('POST /api/auth/hub — 401 for ANY refusal of the ticket, all alike', () => {
  it('every kind of bad ticket gets the same 401 and the same envelope', async () => {
    const iatPast = nowSec() - 120;
    const cases: Array<[string, string]> = [
      ['another app', await ticket({ aud: 'paratravel' })],
      ['another issuer', await ticket({ iss: 'apphub-hub-staging' })],
      ['another key', await ticket({ key: impostor.privateKey })],
      ['expired', await ticket({ iat: iatPast, exp: iatPast + 60 })],
      ['too long a life', await ticket({ iat: nowSec(), exp: nowSec() + 61 })],
      ['issued in the future', await ticket({ iat: nowSec() + 30, exp: nowSec() + 90 })],
      ['bad snapshot', await ticket({ snapshot: { phone: '+7900' } })],
      ['not a token at all', 'definitely.not.a-jws'],
    ];

    const bodies = new Set<string>();
    for (const [name, t] of cases) {
      const res = await call({ hub_ticket: t });
      expect(res.statusCode, name).toBe(401);
      const out = JSON.parse(res.body) as { error: string; errorId: string; detail?: string };
      expect(out.error, name).toBe('unauthorized');
      expect(out.detail, name).toBeUndefined();
      bodies.add(JSON.stringify({ ...out, errorId: '' }));
    }
    // 🔴 One and the same answer for all eight: a probe cannot learn WHICH check it tripped,
    // and cannot use the door to find out whether an account exists.
    expect(bodies.size).toBe(1);
  });

  it('🔴 the machine reason goes to the LOG and never into the answer', async () => {
    const spy = vi.spyOn(console, 'error');
    const res = await call({ hub_ticket: await ticket({ aud: 'cargobob' }) });

    expect(res.statusCode).toBe(401);
    for (const reason of ALL_REASONS) expect(res.body).not.toContain(reason);
    // …while the server log says exactly which check refused it.
    expect(spy.mock.calls.flat().join(' ')).toContain('[auth/hub] refused: aud_mismatch');
  });
});

describe('POST /api/auth/hub — 503 when the fault is OURS', () => {
  it('🔴 no hub key configured -> 503, NOT 401', async () => {
    // 401 here would send a person to reinstall the app over our own missing env var.
    const t = await ticket();
    delete process.env[HUB_TICKET_PUBLIC_KEY_ENV];

    const res = await call({ hub_ticket: t });
    expect(res.statusCode).toBe(503);
    expect((JSON.parse(res.body) as { error: string }).error).toBe('service_unavailable');
  });

  it('🔴 a key that is not Ed25519 -> 503 as well (it is a typo, not a forgery)', async () => {
    const t = await ticket();
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();

    expect((await call({ hub_ticket: t })).statusCode).toBe(503);
  });

  it('the 503 answer carries no reason and no key material either', async () => {
    const t = await ticket();
    delete process.env[HUB_TICKET_PUBLIC_KEY_ENV];

    const res = await call({ hub_ticket: t });
    for (const reason of ALL_REASONS) expect(res.body).not.toContain(reason);
    expect(res.body).not.toContain('BEGIN PUBLIC KEY');
    expect(res.body).not.toContain('HUB_TICKET_PUBLIC_KEY');
  });

  it('a missing BOT_TOKEN is the same class of fault -> 503, not a crash', async () => {
    const t = await ticket();
    const saved = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;
    try {
      expect((await call({ hub_ticket: t })).statusCode).toBe(503);
    } finally {
      process.env.BOT_TOKEN = saved;
    }
  });
});

// =======================================================================================
// FIX №9 (007): THE TWO LOG INVARIANTS FINALLY HAVE A COMPANION TEST ON THE REFUSAL PATH.
//
// "The ticket never reaches a log, whole or in part" (hub-ticket.ts invariant 5) and "the
// log gets the NAME of the variable, never its value" (invariant 8) were, until now, only
// SENTENCES: every test silenced the log instead of reading it. Tomorrow somebody debugging
// adds `ticket.slice(0, 32)` to the refusal line "just to see what came in", and not one of
// the 1277 tests reddens — while the Vercel log is read by more people than the database.
//
// This drives real refusals with KNOWN values and greps EVERYTHING console.error and
// console.warn were given, per class of forbidden value, rather than checking one chosen
// line (skill log-invariant-verify-on-real-sink-every-mode.md: the leak hides in the
// SECOND record).
// =======================================================================================
describe('POST /api/auth/hub — the refusal path never prints a value (fix №9)', () => {
  /** A telegram id that exists nowhere else in this file — so a hit is a real hit. */
  const SUB = '761543098761';

  it('🔴 no key body, no ticket, no telegram id, no pass — in any refusal line', async () => {
    const err = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // A ticket signed by the real key, so a debug line would have something worth printing.
    const good = await ticket({ sub: SUB, snapshot: { language: 'ru' } });
    // The pass that ticket buys — the fourth forbidden class.
    const okRes = await call({ hub_ticket: good });
    const pass = (JSON.parse(okRes.body) as { token: string }).token;

    // Every refusal shape the door has, each with its own reason inside.
    const forged = await ticket({ sub: SUB, key: impostor.privateKey });
    const wrongApp = await ticket({ sub: SUB, aud: 'cargobob' });
    const badSnap = await ticket({ sub: SUB, snapshot: { phone: '+79001234567' } });
    await call({ hub_ticket: forged });
    await call({ hub_ticket: wrongApp });
    await call({ hub_ticket: badSnap });
    await call({ hub_ticket: 'definitely.not.a-jws' });
    await call({ hub_ticket: 'x'.repeat(5000) }); // 400, the shape complaint
    await call({ hub_ticket: pass }); // a PASS offered where a ticket belongs

    // …and the configuration fault, with a key really sitting in the variable — the case
    // where there IS key material at hand to print.
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    const wrongKeyBody = (process.env[HUB_TICKET_PUBLIC_KEY_ENV] as string)
      .split('\n')
      .filter((l) => !l.startsWith('-----') && l.trim().length > 0)[1] as string;
    await call({ hub_ticket: good });
    delete process.env[HUB_TICKET_PUBLIC_KEY_ENV];
    await call({ hub_ticket: good });

    const printed = [...err.mock.calls, ...warn.mock.calls].flat().map(String).join('\n');
    expect(printed.length).toBeGreaterThan(0); // the log DOES say something — see below

    // 1. NO KEY MATERIAL. Not the body of the wrong key, not any PEM at all.
    expect(printed).not.toContain(wrongKeyBody);
    expect(printed).not.toContain('BEGIN PUBLIC KEY');
    expect(printed).not.toContain(HUB_PEM.split('\n')[1] as string);

    // 2. NO TICKET, whole or in part — including the "just the first 32 characters" that a
    //    debugging session reaches for first.
    for (const t of [good, forged, wrongApp, badSnap]) {
      expect(printed).not.toContain(t);
      expect(printed).not.toContain(t.slice(0, 32));
      expect(printed).not.toContain(t.split('.')[1] as string); // the payload segment
      expect(printed).not.toContain(t.split('.')[2] as string); // the signature
    }

    // 3. NO TELEGRAM ID. It is inside every one of those tickets.
    expect(printed).not.toContain(SUB);

    // 4. NO PASS.
    expect(printed).not.toContain(pass);
    expect(printed).not.toContain(pass.slice(0, 24));
  });

  it('🔴 what it DOES print: the machine reason, and for a config fault the variable NAME', async () => {
    // The other half of the invariant — "never a value" must not be satisfied by printing
    // nothing at all, or an incident becomes unreadable in the other direction.
    const err = vi.spyOn(console, 'error');
    const good = await ticket({ sub: SUB });

    await call({ hub_ticket: await ticket({ sub: SUB, aud: 'cargobob' }) });
    const afterRefusal = err.mock.calls.flat().map(String).join('\n');
    expect(afterRefusal).toContain('[auth/hub] refused: aud_mismatch');

    err.mockClear();
    delete process.env[HUB_TICKET_PUBLIC_KEY_ENV];
    await call({ hub_ticket: good });
    const afterConfig = err.mock.calls.flat().map(String).join('\n');
    expect(afterConfig).toContain('not_configured');
    expect(afterConfig).toContain(HUB_TICKET_PUBLIC_KEY_ENV); // the NAME, and only the name
  });

  it('🔴 ONE refusal is ONE line from the door, not two (fix №11)', async () => {
    // Before: verifyHubTicket printed its own `[hub-ticket] refusing: …` AND the door
    // printed `[auth/hub] refused: …`, so a single missing env var read as two events in
    // the log — and the one that named the variable was the one nobody grepped for.
    const err = vi.spyOn(console, 'error');
    const t = await ticket();
    delete process.env[HUB_TICKET_PUBLIC_KEY_ENV];

    expect((await call({ hub_ticket: t })).statusCode).toBe(503);

    const lines = err.mock.calls.flat().map(String);
    expect(lines.filter((l) => l.includes('[hub-ticket]'))).toHaveLength(0);
    expect(lines.filter((l) => l.includes('refused:'))).toHaveLength(1);
  });
});
