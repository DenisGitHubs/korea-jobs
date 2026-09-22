// lib/korea/core/hub-ticket.test.ts
//
// verifyHubTicket is the SECOND door into the whole application — everything behind it
// trusts the telegram_id this file returns. So the suite drives it with REAL Ed25519
// keys generated inside the test and REAL tickets signed by jose (the same library the
// hub signs with): no crypto is mocked, and the positive case proves the whole chain.
//
// What is pinned here, beyond "a good ticket passes":
//   * the TWO algorithm guards are DISTINCT — our header check answers 'bad_alg', jose's
//     answers 'bad_alg_late'. Every test below that expects 'bad_alg' reddens the moment
//     our own guard is deleted, which is exactly what a single shared code failed to do;
//   * 'not_configured' (-> 503) is reachable BOTH ways: no key at all, and a key that is
//     not Ed25519. The second one is not theory: measured on jose 5.10, importSPKI(pem,
//     'EdDSA') accepts an RSA or a P-256 key silently, so the type check has to be ours;
//   * a 19-digit sub (> 2^53) gets in and comes back as the EXACT string — the deliberate
//     difference from the ParaTravel copy of this door;
//   * the three written forms of the public key all work (a PEM, a PEM with two-character
//     \n, base64 of the whole file);
//   * the accepted replay risk is DOCUMENTED by a test, not left in a comment.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import {
  HUB_TICKET_AUDIENCE,
  HUB_TICKET_ISSUER,
  HUB_TICKET_MAX_LANGUAGE_CHARS,
  HUB_TICKET_PUBLIC_KEY_ENV,
  verifyHubTicket,
  isHubTicketConfigured,
} from './hub-ticket.js';
import { mintHubSession, verifyHubSession } from './hub-session.js';

/** The hub's key pair, as the hub would hold it. Generated once for the whole file. */
const hub = generateKeyPairSync('ed25519');
const HUB_PEM = hub.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** A DIFFERENT Ed25519 pair — "signed by somebody, just not the hub". */
const impostor = generateKeyPairSync('ed25519');

const nowSec = () => Math.floor(Date.now() / 1000);
const newJti = () => randomBytes(16).toString('base64url'); // 22 chars — the hub's shape

interface TicketFields {
  sub?: string;
  aud?: string | string[];
  iss?: string;
  jti?: string;
  iat?: number;
  exp?: number;
  snapshot?: unknown;
  key?: KeyObject;
}

/** A ticket signed exactly the way the hub signs one (jose, EdDSA, typ JWT). */
async function ticket(fields: TicketFields = {}): Promise<string> {
  const iat = fields.iat ?? nowSec();
  const exp = fields.exp ?? iat + 60;
  const body = fields.snapshot === undefined ? {} : { snapshot: fields.snapshot };
  return new SignJWT(body as Record<string, unknown>)
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setIssuer(fields.iss ?? HUB_TICKET_ISSUER)
    .setAudience(fields.aud ?? HUB_TICKET_AUDIENCE)
    .setSubject(fields.sub ?? '555000111')
    .setJti(fields.jti ?? newJti())
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(fields.key ?? hub.privateKey);
}

const b64url = (v: unknown): string =>
  Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf8').toString('base64url');

/**
 * A ticket assembled BY HAND with a real Ed25519 signature. Needed for the header games
 * jose refuses to sign at all (alg:none, crit) — the point of those tests is our own
 * header guard, which runs before any library sees the token.
 */
function rawTicket(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const signed = `${b64url(header)}.${b64url(payload)}`;
  const sig = sign(null, Buffer.from(signed, 'utf8'), hub.privateKey);
  return `${signed}.${sig.toString('base64url')}`;
}

/** A well-formed payload for the hand-assembled tickets above. */
function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = nowSec();
  return {
    iss: HUB_TICKET_ISSUER,
    aud: HUB_TICKET_AUDIENCE,
    sub: '555000111',
    jti: newJti(),
    iat,
    exp: iat + 60,
    ...over,
  };
}

/** The reason of a refusal, or the string 'ACCEPTED' when the ticket passed. */
async function reasonOf(t: string): Promise<string> {
  const res = await verifyHubTicket(t);
  return res.ok ? 'ACCEPTED' : res.reason;
}

beforeEach(() => {
  process.env[HUB_TICKET_PUBLIC_KEY_ENV] = HUB_PEM;
  process.env.BOT_TOKEN = '123456:AA_test_bot_token_for_unit_tests_only';
  // The refusal log carries the NAME of the setting; keep it out of the test output.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env[HUB_TICKET_PUBLIC_KEY_ENV];
  vi.restoreAllMocks();
});

describe('verifyHubTicket — a real hub ticket gets in', () => {
  it('accepts a correctly signed, fresh ticket and returns the identity', async () => {
    const jti = newJti();
    const res = await verifyHubTicket(await ticket({ jti, snapshot: { language: 'ru' } }));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.identity.telegramId).toBe('555000111');
    expect(res.identity.app).toBe(HUB_TICKET_AUDIENCE);
    expect(res.identity.jti).toBe(jti);
    expect(res.identity.language).toBe('ru');
    expect(res.identity.expiresAt - res.identity.issuedAt).toBe(60);
  });

  it('🔴 a 19-digit sub (> 2^53) gets in and comes back as the EXACT string', async () => {
    // users.telegram_id is a bigint here. Number('9007199254740993') is 9007199254740992 —
    // i.e. somebody ELSE's account, with not one error in the log. Nothing in this module
    // is allowed to turn the id into a number, so this is the test that says so.
    const big = '9007199254740993';
    const res = await verifyHubTicket(await ticket({ sub: big }));

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.identity.telegramId).toBe(big);
  });

  it('a ticket with no snapshot at all passes, with language = null', async () => {
    const res = await verifyHubTicket(await ticket());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.identity.language).toBeNull();
  });

  it('lower-cases the language tag but keeps the region part', async () => {
    const res = await verifyHubTicket(await ticket({ snapshot: { language: 'PT-BR' } }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.identity.language).toBe('pt-br');
  });
});

describe('verifyHubTicket — the public key, in all three written forms', () => {
  it('accepts the PEM as-is (Vercel keeps real newlines)', async () => {
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = HUB_PEM;
    expect(await reasonOf(await ticket())).toBe('ACCEPTED');
  });

  it('accepts a PEM written on ONE line with two-character \\n (the usual .env)', async () => {
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = HUB_PEM.replace(/\n/g, '\\n');
    expect(await reasonOf(await ticket())).toBe('ACCEPTED');
  });

  it('accepts base64 of the whole PEM file', async () => {
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = Buffer.from(HUB_PEM, 'utf8').toString('base64');
    expect(await reasonOf(await ticket())).toBe('ACCEPTED');
  });

  // FIX №6 (007, nit): the function answered "the variable is non-empty" while calling
  // itself "configured" — and the DOOR means by that word "there is at least one usable
  // Ed25519 key". Harmless only while the sole caller was this test: the first caller from
  // real code would have been told a confident "configured" over a list of junk, and then
  // watched the door answer 503 to every genuine ticket.
  it('🔴 isHubTicketConfigured answers the DOOR\'s question: a usable key, not a non-empty string', () => {
    expect(isHubTicketConfigured()).toBe(true);

    // Junk, an RSA key and a PRIVATE key are all "a non-empty string" — and none of them
    // opens this door. Each of these three reddens on the old one-line body.
    for (const value of [
      'not-a-key-at-all',
      generateKeyPairSync('rsa', { modulusLength: 2048 })
        .publicKey.export({ type: 'spki', format: 'pem' })
        .toString(),
      hub.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    ]) {
      process.env[HUB_TICKET_PUBLIC_KEY_ENV] = value;
      expect(isHubTicketConfigured(), value.slice(0, 24)).toBe(false);
    }

    // …and a list in which ONE entry is usable is configured, exactly like the door.
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = `not-a-key-at-all,${HUB_PEM}`;
    expect(isHubTicketConfigured()).toBe(true);

    delete process.env[HUB_TICKET_PUBLIC_KEY_ENV];
    expect(isHubTicketConfigured()).toBe(false);
  });
});

describe('verifyHubTicket — an UNCONFIGURED server says so (503, never 401)', () => {
  it("no key at all -> 'not_configured'", async () => {
    const t = await ticket();
    delete process.env[HUB_TICKET_PUBLIC_KEY_ENV];
    expect(await reasonOf(t)).toBe('not_configured');
  });

  it("an empty / whitespace value -> 'not_configured'", async () => {
    const t = await ticket();
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = '   ';
    expect(await reasonOf(t)).toBe('not_configured');
  });

  it("🔴 a value that IS a key but NOT Ed25519 -> 'not_configured', not a signature error", async () => {
    // Measured, not assumed: jose's own importSPKI(pem, 'EdDSA') takes both of these
    // without a word, and the mistake would then show up as 401 on every login — i.e. as
    // "your ticket is forged" for a typo of ours. The type check is ours for that reason.
    const t = await ticket();
    for (const pem of [
      generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    ]) {
      process.env[HUB_TICKET_PUBLIC_KEY_ENV] = pem;
      expect(await reasonOf(t)).toBe('not_configured');
    }
  });

  it("🔴 a PRIVATE key pasted by mistake -> 'not_configured', though it would have WORKED", async () => {
    // Node's createPublicKey() derives the public half from a private key without a word,
    // so this ticket verifies fine — and the hub's private key would be living in our
    // environment, doing its job, with nothing in any log to say so. Invariant 2 is a rule
    // only while this test is here: delete the marker check and this reddens.
    const t = await ticket();
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = hub.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(await reasonOf(t)).toBe('not_configured');
  });

  it('garbage in the variable -> not_configured (and never an exception)', async () => {
    const t = await ticket();
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = '-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----';
    await expect(verifyHubTicket(t)).resolves.toEqual({ ok: false, reason: 'not_configured' });
  });
});

describe('verifyHubTicket — the algorithm is pinned, by OUR guard first', () => {
  it("🔴 alg 'none' dies under OUR code 'bad_alg' (not the library's 'bad_alg_late')", async () => {
    const t = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload())}.`;
    expect(await reasonOf(t)).toBe('bad_alg');
  });

  it("🔴 HS256 signed with OUR OWN PUBLIC KEY as the secret dies under 'bad_alg'", async () => {
    // The classic confusion attack: the "public" key is a perfectly good HMAC secret, and it
    // is public. If this ever answers 'bad_alg_late', our header guard is gone and only the
    // library is holding the door.
    const t = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(HUB_TICKET_ISSUER)
      .setAudience(HUB_TICKET_AUDIENCE)
      .setSubject('555000111')
      .setJti(newJti())
      .setIssuedAt()
      .setExpirationTime(nowSec() + 60)
      .sign(Buffer.from(HUB_PEM, 'utf8'));
    expect(await reasonOf(t)).toBe('bad_alg');
  });

  it("a header carrying its own key (jwk/jku/x5u/x5c) or crit -> 'bad_alg'", async () => {
    for (const extra of [
      { jwk: { kty: 'OKP', crv: 'Ed25519', x: 'AAAA' } },
      { jku: 'https://attacker.example/keys.json' },
      { x5u: 'https://attacker.example/cert.pem' },
      { x5c: ['MIIB'] },
      { crit: ['exp'] },
    ]) {
      const t = rawTicket({ alg: 'EdDSA', typ: 'JWT', ...extra }, payload());
      expect(await reasonOf(t), JSON.stringify(extra)).toBe('bad_alg');
    }
  });

  it("typ present and not 'JWT' -> 'bad_form'", async () => {
    const t = rawTicket({ alg: 'EdDSA', typ: 'at+jwt' }, payload());
    expect(await reasonOf(t)).toBe('bad_form');
  });

  it('typ absent is fine — it is optional in JWS', async () => {
    const t = rawTicket({ alg: 'EdDSA' }, payload());
    expect(await reasonOf(t)).toBe('ACCEPTED');
  });
});

describe('verifyHubTicket — who signed, for whom, and for how long', () => {
  it("signed by a DIFFERENT Ed25519 key -> 'bad_signature'", async () => {
    expect(await reasonOf(await ticket({ key: impostor.privateKey }))).toBe('bad_signature');
  });

  it("a tampered body (same signature) -> 'bad_signature'", async () => {
    const t = await ticket();
    const [h, , s] = t.split('.') as [string, string, string];
    expect(await reasonOf(`${h}.${b64url(payload({ sub: '999' }))}.${s}`)).toBe('bad_signature');
  });

  it("a ticket for ANOTHER application -> 'aud_mismatch'", async () => {
    expect(await reasonOf(await ticket({ aud: 'paratravel' }))).toBe('aud_mismatch');
  });

  it("🔴 an ARRAY aud is refused even when it CONTAINS our name -> 'aud_mismatch'", async () => {
    // jose is happy with an array that contains the expected audience; this door is not.
    expect(await reasonOf(await ticket({ aud: [HUB_TICKET_AUDIENCE] }))).toBe('aud_mismatch');
    expect(await reasonOf(await ticket({ aud: [HUB_TICKET_AUDIENCE, 'cargobob'] }))).toBe('aud_mismatch');
  });

  it("another issuer -> 'iss_mismatch'", async () => {
    expect(await reasonOf(await ticket({ iss: 'apphub-hub-staging' }))).toBe('iss_mismatch');
  });

  it("already expired -> 'expired'", async () => {
    const iat = nowSec() - 120;
    expect(await reasonOf(await ticket({ iat, exp: iat + 60 }))).toBe('expired');
  });

  it("🔴 exp - iat = 61 -> 'ttl_too_long', even with a perfect signature", async () => {
    // "Signed by the hub" does not mean "lives an hour": one second over the agreed 60 is
    // already a different contract.
    const iat = nowSec();
    expect(await reasonOf(await ticket({ iat, exp: iat + 61 }))).toBe('ttl_too_long');
  });

  it('exp - iat = 60 exactly is still fine (the boundary belongs to the ticket)', async () => {
    const iat = nowSec();
    expect(await reasonOf(await ticket({ iat, exp: iat + 60 }))).toBe('ACCEPTED');
  });

  it("issued in the future beyond the 5 s skew -> 'issued_in_future'", async () => {
    const iat = nowSec() + 30;
    expect(await reasonOf(await ticket({ iat, exp: iat + 60 }))).toBe('issued_in_future');
  });

  it('a few seconds of clock difference are tolerated (5 s skew)', async () => {
    const iat = nowSec() + 3;
    expect(await reasonOf(await ticket({ iat, exp: iat + 60 }))).toBe('ACCEPTED');
  });
});

describe('verifyHubTicket — the claims themselves', () => {
  it("sub that is not a decimal string -> 'bad_sub'", async () => {
    for (const sub of ['', 'abc', '55 5', '-1', '1.0', '1'.repeat(26)]) {
      expect(await reasonOf(await ticket({ sub })), sub).toBe('bad_sub');
    }
  });

  it("a NUMERIC sub -> 'bad_sub' (a ticket must carry the id as a string)", async () => {
    const t = rawTicket({ alg: 'EdDSA', typ: 'JWT' }, payload({ sub: 555000111 }));
    expect(await reasonOf(t)).toBe('bad_sub');
  });

  it("a jti outside the hub's shape -> 'bad_jti'", async () => {
    for (const jti of ['short', 'A'.repeat(87), 'has spaces in it here', 'plus+slash/=']) {
      expect(await reasonOf(await ticket({ jti })), jti).toBe('bad_jti');
    }
  });

  it("a missing jti -> 'bad_jti'", async () => {
    const p = payload();
    delete p['jti'];
    expect(await reasonOf(rawTicket({ alg: 'EdDSA', typ: 'JWT' }, p))).toBe('bad_jti');
  });

  it("an UNKNOWN field in the snapshot -> 'bad_snapshot' (the whitelist is exactly ['language'])", async () => {
    // The snapshot is signed, so its composition is part of the contract — a new field is a
    // conversation between the two sides, not something that quietly rides along.
    expect(await reasonOf(await ticket({ snapshot: { language: 'ru', phone: '+7900' } }))).toBe('bad_snapshot');
    expect(await reasonOf(await ticket({ snapshot: { allows_write_to_pm: true } }))).toBe('bad_snapshot');
  });

  it("a malformed language tag -> 'bad_snapshot'", async () => {
    for (const language of ['r', 'русский', 'ru_RU', 'ru-', 12, null]) {
      expect(await reasonOf(await ticket({ snapshot: { language } })), String(language)).toBe('bad_snapshot');
    }
  });

  it("a snapshot that is not an object -> 'bad_snapshot'", async () => {
    for (const snapshot of ['ru', 42, ['ru']]) {
      expect(await reasonOf(await ticket({ snapshot })), JSON.stringify(snapshot)).toBe('bad_snapshot');
    }
  });

  it("garbage that is not a JWS at all -> 'bad_form'", async () => {
    for (const t of ['', '   ', 'not-a-token', 'a.b', 'a.b.c.d', `${'x'.repeat(4097)}`]) {
      expect(await reasonOf(t), JSON.stringify(t.slice(0, 12))).toBe('bad_form');
    }
  });

  it("a header that is not JSON -> 'bad_form'", async () => {
    expect(await reasonOf('bm90LWpzb24.e30.c2ln')).toBe('bad_form');
  });
});

describe('verifyHubTicket — ACCEPTED RISK: a ticket is a BEARER token and we keep no jti store', () => {
  it('the SAME ticket presented twice inside its 60 s yields TWO usable day-long passes', async () => {
    // 🔴 This is not a wish — it is the behaviour the owner accepted, written down so that
    // nobody later reads it as a defect and "fixes" it by hand. Whoever copies a ticket
    // inside its window gets a day of access, and nothing here notices the second use:
    // the 60 seconds protect the TICKET, not its CONSEQUENCE. Closing it needs a persistent
    // store of spent jti (in-process is worth nothing on serverless) — i.e. a migration,
    // and that awaits the owner. The hub accepted the same risk on its side.
    const botToken = process.env.BOT_TOKEN as string;
    const t = await ticket();

    const first = await verifyHubTicket(t);
    const second = await verifyHubTicket(t);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.identity.jti).toBe(first.identity.jti); // the very same ticket

    const passA = mintHubSession(
      first.identity.telegramId,
      first.identity.language,
      first.identity.jti,
      botToken,
    );
    const passB = mintHubSession(
      second.identity.telegramId,
      second.identity.language,
      second.identity.jti,
      botToken,
    );
    expect(verifyHubSession(passA.token, botToken).ok).toBe(true);
    expect(verifyHubSession(passB.token, botToken).ok).toBe(true);
    // Both live far longer than the ticket that produced them.
    expect(passB.expiresAt - nowSec()).toBeGreaterThan(3600);

    // 🔴 WHAT CHANGED ON 23.09.2026 (fix №2): the risk is still accepted, but it is no
    // longer un-investigable. Both passes now CARRY the jti of the ticket they came from,
    // so the two sessions can be tied to one ticket — and to the `[auth/hub] ok jti=…`
    // line — instead of looking like two unrelated, honest logins.
    const a = verifyHubSession(passA.token, botToken);
    const b = verifyHubSession(passB.token, botToken);
    if (a.ok && b.ok) {
      expect(a.claims.jti).toBe(first.identity.jti);
      expect(b.claims.jti).toBe(a.claims.jti);
    }
  });
});

// =======================================================================================
// THE 23.09.2026 REVIEW FIXES
// =======================================================================================

// FIX №5 (Хейтер): `sub` is bounded by the COLUMN (bigint), not by "digits".
describe('verifyHubTicket — sub must fit users.telegram_id (fix №5)', () => {
  it('🔴 twenty digits -> bad_sub: it would fail ::bigint and print itself into our log', async () => {
    // The path being closed: such a sub passed every check here, got a day-long pass, and
    // then blew up on `${sub}::bigint` on EVERY request — Postgres quotes the value it
    // refused, api/index.ts prints cause.message + stack, and the telegram_id lands in the
    // Vercel log, once per request, exactly where it was never supposed to be.
    expect(await reasonOf(await ticket({ sub: '9'.repeat(20) }))).toBe('bad_sub');
    expect(await reasonOf(await ticket({ sub: '9223372036854775808' }))).toBe('bad_sub');
  });

  it('🔴 the exact bigint maximum is still let in — we narrowed to the column, not below it', async () => {
    const max = '9223372036854775807';
    const res = await verifyHubTicket(await ticket({ sub: max }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.identity.telegramId).toBe(max);
  });
});

// FIX №7 (Хейтер): the language tag is bounded where it is BORN.
describe('verifyHubTicket — the language tag has an upper bound (fix №7)', () => {
  it('🔴 a ~700-character tag that MATCHES the pattern is still refused', async () => {
    // It has to match the pattern, or the test proves nothing: `(-[a-z0-9]{2,8})*` is an
    // unbounded repeat, so a legally-shaped tag could be as long as the whole ticket cap
    // allowed. Signed by the real hub key, it used to be ACCEPTED here, answered 200 at
    // the door, and produced a pass past HUB_SESSION_MAX_CHARS — refused on every request.
    const tag = 'ru' + '-abcdefgh'.repeat(80); // 722 characters, perfectly well formed
    expect(tag.length).toBeGreaterThan(700);
    expect(await reasonOf(await ticket({ snapshot: { language: tag } }))).toBe('bad_snapshot');
  });

  it('the boundary: 35 characters pass, 36 do not', async () => {
    expect(HUB_TICKET_MAX_LANGUAGE_CHARS).toBe(35);
    const t35 = 'ru' + '-abcdefgh'.repeat(3) + '-abcde'; // 35
    const t36 = 'ru' + '-abcdefgh'.repeat(3) + '-abcdef'; // 36
    expect(t35).toHaveLength(35);
    expect(t36).toHaveLength(36);
    expect(await reasonOf(await ticket({ snapshot: { language: t35 } }))).toBe('ACCEPTED');
    expect(await reasonOf(await ticket({ snapshot: { language: t36 } }))).toBe('bad_snapshot');
  });

  it('a real tag is untouched by the bound', async () => {
    for (const tag of ['ru', 'en', 'uz', 'pt-BR', 'zh-Hans-CN']) {
      expect(await reasonOf(await ticket({ snapshot: { language: tag } })), tag).toBe('ACCEPTED');
    }
  });
});

// FIX №8 (007): HUB_TICKET_PUBLIC_KEY is a LIST, so rotating the hub's key pair does not
// turn every genuine ticket into a 401 that is indistinguishable from an attack.
describe('verifyHubTicket — the key variable is a LIST (fix №8)', () => {
  const rotated = generateKeyPairSync('ed25519');
  const ROTATED_PEM = rotated.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  it('🔴 two keys configured, the ticket signed by the SECOND one -> ACCEPTED', async () => {
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = `${HUB_PEM},${ROTATED_PEM}`;
    expect(await reasonOf(await ticket({ key: rotated.privateKey }))).toBe('ACCEPTED');
    // …and the OLD key keeps working at the same time — that is the whole point: the
    // rotation is two edits of one variable with no window in which the door is shut.
    expect(await reasonOf(await ticket())).toBe('ACCEPTED');
  });

  // FIX №3 OF THE THIRD ROUND (007, major): THE MOST NATURAL WAY TO WRITE TWO KEYS WAS THE
  // ONE THE SPLITTER DID NOT UNDERSTAND. In the Vercel panel a hand types …END PUBLIC
  // KEY-----, Enter, -----BEGIN PUBLIC KEY… — one newline, no blank line. That stayed ONE
  // chunk: createPublicKey() reads only the first block, or throws and takes every key with
  // it into 'not_configured'. Either way the NEW key is invisible at exactly the moment of
  // the rotation, and the log fills with bad_signature for every GENUINE ticket — the 401
  // storm the list was added to prevent.
  //
  // The test below the old one could not catch it: a PEM from export() already ends in a
  // newline, so gluing two of them with '\n' produces a blank line by accident. Here the
  // first PEM is TRIMMED, so the boundary is the only separator there is.
  it('🔴 two PEMs one under the other, a SINGLE newline between them (END -> Enter -> BEGIN)', async () => {
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = `${HUB_PEM.trimEnd()}\n${ROTATED_PEM.trimEnd()}`;
    // Proof that there is no blank line anywhere in the value — otherwise this test would
    // be passing for the old reason.
    expect(process.env[HUB_TICKET_PUBLIC_KEY_ENV]).not.toMatch(/\n\s*\n/);

    // The NEW key — the one a rotation adds — is the one that must be found.
    expect(await reasonOf(await ticket({ key: rotated.privateKey }))).toBe('ACCEPTED');
    // …and the old one keeps working beside it, which is what makes the rotation seamless.
    expect(await reasonOf(await ticket())).toBe('ACCEPTED');
  });

  it('🔴 the same, written the .env way: one two-character \\n between the two PEMs', async () => {
    const oneLine = (pem: string): string => pem.trimEnd().replace(/\n/g, '\\n');
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = `${oneLine(HUB_PEM)}\\n${oneLine(ROTATED_PEM)}`;
    expect(process.env[HUB_TICKET_PUBLIC_KEY_ENV]).not.toMatch(/\\n\s*\\n/);
    expect(await reasonOf(await ticket({ key: rotated.privateKey }))).toBe('ACCEPTED');
    expect(await reasonOf(await ticket())).toBe('ACCEPTED');
  });

  it('a semicolon and a blank line separate keys just as a comma does', async () => {
    for (const value of [
      `${HUB_PEM};${ROTATED_PEM}`,
      `${HUB_PEM}\n${ROTATED_PEM}`, // each PEM already ends in a newline -> a blank line
      `${HUB_PEM.replace(/\n/g, '\\n')}\\n${ROTATED_PEM.replace(/\n/g, '\\n')}`, // one-line .env
    ]) {
      process.env[HUB_TICKET_PUBLIC_KEY_ENV] = value;
      expect(await reasonOf(await ticket({ key: rotated.privateKey })), value.slice(0, 12)).toBe(
        'ACCEPTED',
      );
    }
  });

  it('an unusable ENTRY is skipped, not fatal, while a usable one stands beside it', async () => {
    // The list is edited by hand, under pressure, during an incident. One bad line must
    // not shut a door that has a good key in it.
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = `${rsa},not-a-key-at-all,${HUB_PEM}`;
    expect(await reasonOf(await ticket())).toBe('ACCEPTED');
  });

  it("a list with nothing usable in it -> 'not_configured' (503, not 401)", async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = `${rsa};junk;;`;
    expect(await reasonOf(await ticket())).toBe('not_configured');
  });

  it("signed by nobody in the list -> 'bad_signature' (401), not 'not_configured'", async () => {
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = `${HUB_PEM},${ROTATED_PEM}`;
    expect(await reasonOf(await ticket({ key: impostor.privateKey }))).toBe('bad_signature');
  });

  it('a claim fault is reported as itself, not masked by the next key bad_signature', async () => {
    // jose checks the signature before the claims, so 'expired'/'aud_mismatch' can only
    // come from the key that really signed — we stop there instead of walking on.
    process.env[HUB_TICKET_PUBLIC_KEY_ENV] = `${ROTATED_PEM},${HUB_PEM}`;
    const iat = nowSec() - 120;
    expect(await reasonOf(await ticket({ iat, exp: iat + 60 }))).toBe('expired');
    expect(await reasonOf(await ticket({ aud: 'paratravel' }))).toBe('aud_mismatch');
  });
});

// FIX №10 (007): the cheap shape test runs BEFORE the key is read — and the invariant that
// had to survive the reorder: something that LOOKS like a ticket still gets 503.
describe('verifyHubTicket — shape first, key second (fix №10)', () => {
  it('🔴 a WELL-FORMED ticket on an unconfigured server still answers not_configured', async () => {
    // This is the invariant, and it is the reason the reorder is only PARTIAL: 401 here
    // would send a person to reinstall an app over our own missing env var.
    const t = await ticket();
    delete process.env[HUB_TICKET_PUBLIC_KEY_ENV];
    expect(await reasonOf(t)).toBe('not_configured');
  });

  it('🔴 bare junk is refused on its own SHAPE and never buys a key parse', async () => {
    // With no key configured the two answers are distinguishable: 'bad_form' proves the
    // shape check ran first. Move the key read back to the top and every one of these
    // turns into 'not_configured' — which is also what a probe used to get for free: a
    // free answer to "is this door configured at all?".
    delete process.env[HUB_TICKET_PUBLIC_KEY_ENV];
    for (const junk of ['', '   ', 'not-a-token', 'a.b', 'a.b.c.d', 'x'.repeat(5000)]) {
      expect(await reasonOf(junk), JSON.stringify(junk.slice(0, 12))).toBe('bad_form');
    }
  });

  it('a non-canonical base64url segment is junk too (fix №6, the same disease as the pass)', async () => {
    const t = await ticket();
    const [h, p, s] = t.split('.') as [string, string, string];
    expect(await reasonOf(`${h}.${p}.${s}!!!!`)).toBe('bad_form');
    expect(await reasonOf(`${h}!.${p}.${s}`)).toBe('bad_form');
    expect(await reasonOf(`${h}.${p}=.${s}`)).toBe('bad_form');
    // The control: untouched, the same ticket is fine.
    expect(await reasonOf(t)).toBe('ACCEPTED');
  });
});

// FIX №11 (Цензор + Хейтер): ONE refusal is ONE log line, and the module is not the one
// that prints it.
describe('verifyHubTicket — the module prints nothing at all (fix №11)', () => {
  it('🔴 an unconfigured server produces NO line from here; the door prints the only one', async () => {
    const err = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = await ticket();
    delete process.env[HUB_TICKET_PUBLIC_KEY_ENV];

    expect(await reasonOf(t)).toBe('not_configured');
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('no refusal of any kind prints from this module', async () => {
    const err = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const t of [
      await ticket({ key: impostor.privateKey }),
      await ticket({ aud: 'paratravel' }),
      await ticket({ sub: '9'.repeat(20) }),
      'definitely.not.a-jws',
    ]) {
      await verifyHubTicket(t);
    }
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
