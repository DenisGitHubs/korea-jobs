// lib/korea/core/hub-session.test.ts
//
// The pass is the ONLY credential the AppHub Studio shell carries after the exchange, so
// everything the app later scopes by user rests on verifyHubSession. Real HMAC throughout —
// nothing is mocked, and the key recipe is re-derived INDEPENDENTLY inside this file
// (createHmac('sha256', 'korea-jobs/hub-session/v1').update(BOT_TOKEN)). That duplication is
// on purpose: it pins the derivation itself, so silently changing the label or the message
// order reddens here instead of quietly invalidating every live pass.
//
// Pinned: the round trip, a 19-digit sub surviving byte for byte, the ways to fail
// (forgery, tampering, another bot's token, expiry), the version marker being INSIDE the
// signed string, and the TTL clamp. Since 23.09.2026 also five fixes of the review:
//   * HUB_SESSION_TTL_SECONDS is a REVOCATION LEVER, not just a mint-time setting (№1);
//   * the ticket's `jti` rides inside the pass and is REQUIRED (№2);
//   * `sub` must fit users.telegram_id — 20 digits is refused, the bigint max is not (№5);
//   * a segment must be CANONICAL base64url: appending junk to the signature is refused,
//     not silently decoded to the same bytes (№6);
//   * a pass we would not accept is never minted — mintHubSession throws instead (№7).
// …and, from the THIRD round of the same review, two more:
//   * the TTL variable fails towards REVOCATION, not towards permission: absent -> the
//     default day, silently; SET but unusable -> the floor plus a line naming it (№1);
//   * the lever is documented where the owner reads it, and honestly — the panel alone
//     changes nothing on Vercel until a redeploy (№4, a TEXT fix with a text guard).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  HUB_SESSION_DEFAULT_TTL_SEC,
  HUB_SESSION_JTI_RE,
  HUB_SESSION_MAX_CHARS,
  HUB_SESSION_MAX_TTL_SEC,
  HUB_SESSION_MIN_TTL_SEC,
  HUB_SESSION_TTL_ENV,
  hubSessionTtlSeconds,
  mintHubSession,
  verifyHubSession,
} from './hub-session.js';
import { HUB_TICKET_JTI_RE } from './hub-ticket.js';

const BOT_TOKEN = '123456:AA_test_bot_token_for_unit_tests_only';
const OTHER_BOT_TOKEN = '999999:BB_a_different_bot_entirely';

/** A ticket id of the hub's shape (base64url of 16 bytes = 22 characters). */
const JTI = 'Zm9vYmFyYmF6cXV4MTIzNA';

const nowSec = () => Math.floor(Date.now() / 1000);

/** The signing key, derived here from scratch — see the file header. */
function keyFor(botToken: string): Buffer {
  return createHmac('sha256', 'korea-jobs/hub-session/v1').update(botToken).digest();
}

/** Assemble a pass by hand so the BODY can say things mintHubSession would never say. */
function forge(claims: unknown, botToken = BOT_TOKEN, version = '1'): string {
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signed = `${version}.${body}`;
  const sig = createHmac('sha256', keyFor(botToken)).update(signed).digest('base64url');
  return `${signed}.${sig}`;
}

const reasonOf = (token: string, botToken = BOT_TOKEN, now?: number): string => {
  const res = now === undefined
    ? verifyHubSession(token, botToken)
    : verifyHubSession(token, botToken, now);
  return res.ok ? 'ACCEPTED' : res.reason;
};

beforeEach(() => {
  delete process.env[HUB_SESSION_TTL_ENV];
});

afterEach(() => {
  delete process.env[HUB_SESSION_TTL_ENV];
});

describe('hub session — mint -> verify round trip', () => {
  it('a freshly minted pass verifies and carries the identity back', () => {
    const { token, expiresAt } = mintHubSession('555000111', 'ru', JTI, BOT_TOKEN);
    const res = verifyHubSession(token, BOT_TOKEN);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.claims.sub).toBe('555000111');
    expect(res.claims.lang).toBe('ru');
    expect(res.claims.exp).toBe(expiresAt);
    expect(res.claims.exp - res.claims.iat).toBe(HUB_SESSION_DEFAULT_TTL_SEC);
  });

  it('the shape is exactly 1.<body>.<signature>', () => {
    const { token } = mintHubSession('555000111', null, JTI, BOT_TOKEN);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('1');
    // The body is readable base64url JSON — the pass is signed, NOT encrypted, and nothing
    // secret may ever be put in it.
    const body = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8'));
    expect(Object.keys(body).sort()).toEqual(['exp', 'iat', 'jti', 'lang', 'sub']);
  });

  it('🔴 a 19-digit telegram id survives byte for byte (users.telegram_id is a bigint)', () => {
    const big = '9007199254740993'; // 2^53 + 1
    const { token } = mintHubSession(big, null, JTI, BOT_TOKEN);
    const res = verifyHubSession(token, BOT_TOKEN);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claims.sub).toBe(big);
    // And it never became a number on the way — that would be someone ELSE's account.
    expect(token).not.toContain('9007199254740992');
  });

  it('a pass with no language (the ticket carried no snapshot) keeps lang = null', () => {
    const { token } = mintHubSession('555000111', null, JTI, BOT_TOKEN);
    const res = verifyHubSession(token, BOT_TOKEN);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claims.lang).toBeNull();
  });

  it('minting refuses a non-decimal id loudly — that is our bug, not a request', () => {
    expect(() => mintHubSession('not-an-id', null, JTI, BOT_TOKEN)).toThrow();
    expect(() => mintHubSession('555', null, JTI, '')).toThrow();
  });
});

// ---------------------------------------------------------------------------------------
// FIX №2 (007, major): THE PASS CARRIES THE TICKET'S jti.
// Replaying a ticket inside its 60 s is an accepted risk — but until the pass carried the
// jti, `[auth/hub] ok jti=X` joined to NOTHING: two passes minted from one ticket were
// indistinguishable from each other and from an honest one, so an incident could not even
// be scoped. These tests are what stops the field being dropped again as "unused".
// ---------------------------------------------------------------------------------------
describe("hub session — the ticket's jti rides inside the pass (fix №2)", () => {
  it('🔴 the jti goes in at mint and comes back out at verify, unchanged', () => {
    const { token } = mintHubSession('555000111', 'ru', JTI, BOT_TOKEN);
    const res = verifyHubSession(token, BOT_TOKEN);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claims.jti).toBe(JTI);
  });

  it("🔴 a pass WITHOUT a jti is refused -> 'bad_jti', even correctly signed", () => {
    const iat = nowSec();
    expect(reasonOf(forge({ sub: '555', lang: null, iat, exp: iat + 60 }))).toBe('bad_jti');
  });

  it("a jti outside the hub's shape -> 'bad_jti'", () => {
    const iat = nowSec();
    for (const jti of ['short', 'A'.repeat(87), 'has spaces here at all', 'plus+slash/=', 42]) {
      expect(
        reasonOf(forge({ sub: '555', lang: null, jti, iat, exp: iat + 60 })),
        String(jti),
      ).toBe('bad_jti');
    }
  });

  it('minting without a usable jti is OUR bug — loud, not a silent empty field', () => {
    expect(() => mintHubSession('555', null, '', BOT_TOKEN)).toThrow();
    expect(() => mintHubSession('555', null, 'short', BOT_TOKEN)).toThrow();
  });

  it('🔴 the pass and the ticket agree on what a jti looks like, letter for letter', () => {
    // hub-session restates the pattern instead of importing it (so `jose` stays off the
    // per-request path). This is the seam that keeps the duplication from drifting: widen
    // one and not the other, and the exchange starts minting passes it then refuses.
    expect(HUB_SESSION_JTI_RE.source).toBe(HUB_TICKET_JTI_RE.source);
    expect(HUB_SESSION_JTI_RE.flags).toBe(HUB_TICKET_JTI_RE.flags);
  });
});

describe('hub session — the ways a pass is refused', () => {
  it("a forged signature -> 'bad_signature'", () => {
    const { token } = mintHubSession('555000111', 'ru', JTI, BOT_TOKEN);
    const [v, body] = token.split('.') as [string, string, string];
    expect(reasonOf(`${v}.${body}.${'A'.repeat(43)}`)).toBe('bad_signature');
  });

  it("a tampered body, original signature -> 'bad_signature'", () => {
    // The interesting forgery: swap the id and keep everything else.
    const { token } = mintHubSession('555000111', 'ru', JTI, BOT_TOKEN);
    const [v, , sig] = token.split('.') as [string, string, string];
    const other = Buffer.from(
      JSON.stringify({
        sub: '777000222',
        lang: 'ru',
        jti: JTI,
        iat: nowSec(),
        exp: nowSec() + 3600,
      }),
      'utf8',
    ).toString('base64url');
    expect(reasonOf(`${v}.${other}.${sig}`)).toBe('bad_signature');
  });

  it("🔴 a pass signed with ANOTHER bot's token -> 'bad_signature'", () => {
    const { token } = mintHubSession('555000111', 'ru', JTI, OTHER_BOT_TOKEN);
    expect(reasonOf(token, BOT_TOKEN)).toBe('bad_signature');
    // …and the same pass is fine for the bot that signed it: the key really is per-bot,
    // so replacing the bot ends every session, by construction and not by a cleanup job.
    expect(reasonOf(token, OTHER_BOT_TOKEN)).toBe('ACCEPTED');
  });

  it("an EXPIRED pass -> 'expired' (checked here, not at the call site)", () => {
    const { token, expiresAt } = mintHubSession('555000111', null, JTI, BOT_TOKEN, 60);
    expect(reasonOf(token, BOT_TOKEN, expiresAt - 1)).toBe('ACCEPTED');
    expect(reasonOf(token, BOT_TOKEN, expiresAt)).toBe('expired');
    expect(reasonOf(token, BOT_TOKEN, expiresAt + 86400)).toBe('expired');
  });

  it("a body whose sub is not a decimal string -> 'bad_sub', even correctly signed", () => {
    const iat = nowSec();
    for (const sub of ['../../etc', '', '555; drop', 5550001 as unknown as string]) {
      expect(
        reasonOf(forge({ sub, lang: null, jti: JTI, iat, exp: iat + 60 })),
        String(sub),
      ).toBe('bad_sub');
    }
  });

  it("missing or non-numeric iat/exp -> 'bad_form'", () => {
    expect(reasonOf(forge({ sub: '555', lang: null, jti: JTI }))).toBe('bad_form');
    expect(reasonOf(forge({ sub: '555', lang: null, jti: JTI, iat: 'now', exp: 'later' }))).toBe(
      'bad_form',
    );
  });

  it("a lang that is neither a string nor null -> 'bad_form'", () => {
    const iat = nowSec();
    expect(reasonOf(forge({ sub: '555', lang: { ru: true }, jti: JTI, iat, exp: iat + 60 }))).toBe(
      'bad_form',
    );
  });

  it("junk that is not a pass at all -> 'bad_form'", () => {
    for (const token of ['', 'abc', '1.2', '1.2.3.4', `1.${'x'.repeat(1100)}.y`, '1..sig', '1.body.']) {
      expect(reasonOf(token), JSON.stringify(token.slice(0, 12))).toBe('bad_form');
    }
  });

  it("an unreadable body behind a VALID signature -> 'bad_form' (never a crash)", () => {
    const body = Buffer.from('not json at all', 'utf8').toString('base64url');
    const sig = createHmac('sha256', keyFor(BOT_TOKEN)).update(`1.${body}`).digest('base64url');
    expect(reasonOf(`1.${body}.${sig}`)).toBe('bad_form');
  });
});

// ---------------------------------------------------------------------------------------
// FIX №5 (Хейтер, minor — but it is a leak): sub must fit users.telegram_id (bigint).
// A 20-digit sub used to pass everything here and then fail `${sub}::bigint` on EVERY later
// request, where Postgres quotes the value into the error, api/index.ts prints
// cause.message + stack, and the telegram_id lands in the Vercel log once per request.
// ---------------------------------------------------------------------------------------
describe('hub session — sub is bounded by the COLUMN, not by "digits" (fix №5)', () => {
  it('🔴 twenty nines -> bad_sub (it would blow up on ::bigint and print itself doing it)', () => {
    const iat = nowSec();
    const sub = '9'.repeat(20);
    expect(reasonOf(forge({ sub, lang: null, jti: JTI, iat, exp: iat + 60 }))).toBe('bad_sub');
    // …and minting one is our own bug, said out loud where it happens.
    expect(() => mintHubSession(sub, null, JTI, BOT_TOKEN)).toThrow();
  });

  it('🔴 the exact bigint maximum still gets in', () => {
    const { token } = mintHubSession('9223372036854775807', null, JTI, BOT_TOKEN);
    const res = verifyHubSession(token, BOT_TOKEN);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claims.sub).toBe('9223372036854775807');
  });

  it('🔴 2^53 + 1 still passes as an EXACT string — the contract we promised is untouched', () => {
    const iat = nowSec();
    const res = verifyHubSession(
      forge({ sub: '9007199254740993', lang: null, jti: JTI, iat, exp: iat + 60 }),
      BOT_TOKEN,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claims.sub).toBe('9007199254740993');
  });
});

// ---------------------------------------------------------------------------------------
// FIX №6 (007, minor): a segment must be CANONICAL base64url.
// Node's decoder silently drops characters outside the alphabet, so `<sig>` and `<sig>!!!!`
// are the same 32 bytes and timingSafeEqual is happy. No privilege is gained — but one pass
// would then have unboundedly many spellings, and every future revocation list,
// de-duplication or correlation done by the token STRING is bypassed by appending junk.
// ---------------------------------------------------------------------------------------
describe('hub session — one pass has exactly one spelling (fix №6)', () => {
  it("🔴 a signature with '!' appended is refused, not decoded to the same bytes", () => {
    const { token } = mintHubSession('555000111', 'ru', JTI, BOT_TOKEN);
    expect(reasonOf(token)).toBe('ACCEPTED'); // the control: the pass itself is good
    expect(reasonOf(`${token}!`)).toBe('bad_form');
    expect(reasonOf(`${token}!!!!`)).toBe('bad_form');
  });

  it('🔴 padding, whitespace and non-alphabet characters in the signature are refused too', () => {
    const { token } = mintHubSession('555000111', 'ru', JTI, BOT_TOKEN);
    const [v, body, sig] = token.split('.') as [string, string, string];
    for (const tail of [`${sig}=`, `${sig} `, `${sig}\n`, `${sig.slice(0, 42)}+`]) {
      expect(reasonOf(`${v}.${body}.${tail}`), JSON.stringify(tail.slice(-3))).toBe('bad_form');
    }
  });

  it('the BODY segment is held to the same alphabet', () => {
    const { token } = mintHubSession('555000111', 'ru', JTI, BOT_TOKEN);
    const [v, body, sig] = token.split('.') as [string, string, string];
    // 'bad_form' and NOT 'bad_signature': the shape is judged before anything is decoded.
    expect(reasonOf(`${v}.${body}!.${sig}`)).toBe('bad_form');
    expect(reasonOf(`${v}.${body}==.${sig}`)).toBe('bad_form');
  });
});

describe('hub session — the version marker is INSIDE the signature', () => {
  it("a pass relabelled 2.<body>.<sig> -> 'bad_form'", () => {
    const { token } = mintHubSession('555000111', null, JTI, BOT_TOKEN);
    const [, body, sig] = token.split('.') as [string, string, string];
    expect(reasonOf(`2.${body}.${sig}`)).toBe('bad_form');
  });

  it('🔴 even a pass correctly SIGNED as version 2 is refused, not read as a version 1', () => {
    // This is what the marker is for: a future format cannot be re-read by an old server.
    const iat = nowSec();
    const v2 = forge({ sub: '555000111', lang: null, jti: JTI, iat, exp: iat + 60 }, BOT_TOKEN, '2');
    expect(reasonOf(v2)).toBe('bad_form');
  });

  it('a version-1 signature does not validate a version-2 string (the prefix is signed)', () => {
    const { token } = mintHubSession('555000111', null, JTI, BOT_TOKEN);
    const [, body] = token.split('.') as [string, string, string];
    const sigOverBodyOnly = createHmac('sha256', keyFor(BOT_TOKEN)).update(body).digest('base64url');
    expect(reasonOf(`1.${body}.${sigOverBodyOnly}`)).toBe('bad_signature');
  });
});

// ---------------------------------------------------------------------------------------
// FIX №1 OF THE THIRD ROUND (007, major): THE REVOCATION SWITCH USED TO FAIL TOWARDS
// PERMISSION. A variable that was SET but unusable fell back to 86400 — the LONGEST life a
// pass may legally have — and did it in silence. `0` is exactly what a person types into
// that box during an incident, meaning "kill everything now"; what he got was "nothing
// changed", with not one line in the log to argue with. The old test PINNED that behaviour
// ('0', '-1', 'NaN' -> the default), which is why nothing ever reddened.
//
// The two cases are now different questions:
//   * ABSENT (unset / empty)      -> the default day, silently. Not a mistake.
//   * SET AND UNUSABLE            -> the FLOOR, plus one loud line naming the variable.
// ---------------------------------------------------------------------------------------
describe('hubSessionTtlSeconds — absent is a quiet default, unusable is a loud floor (fix №1)', () => {
  let err: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const printed = (): string => err.mock.calls.flat().map(String).join('\n');

  it("unset -> a day (the owner's choice), and not one word in the log", () => {
    expect(hubSessionTtlSeconds()).toBe(HUB_SESSION_DEFAULT_TTL_SEC);
    expect(HUB_SESSION_DEFAULT_TTL_SEC).toBe(86400);
    expect(err).not.toHaveBeenCalled();
  });

  it('an empty or blank value is ABSENT, not broken: the day, silently', () => {
    for (const blank of ['', '   ']) {
      process.env[HUB_SESSION_TTL_ENV] = blank;
      expect(hubSessionTtlSeconds(), JSON.stringify(blank)).toBe(HUB_SESSION_DEFAULT_TTL_SEC);
    }
    expect(err).not.toHaveBeenCalled();
  });

  it('a sane value is taken as is, and says nothing', () => {
    process.env[HUB_SESSION_TTL_ENV] = '3600';
    expect(hubSessionTtlSeconds()).toBe(3600);
    expect(err).not.toHaveBeenCalled();
  });

  it('🔴 "0" — the word typed in an incident — is the FLOOR, never a day, and never silent', () => {
    // This is the whole fix in one case. Under the old rule this returned 86400: the
    // person asking for "everything dead now" got the longest pass life there is, and no
    // line anywhere said the value had been thrown away.
    process.env[HUB_SESSION_TTL_ENV] = '0';
    expect(hubSessionTtlSeconds()).toBe(HUB_SESSION_MIN_TTL_SEC);
    expect(hubSessionTtlSeconds()).not.toBe(HUB_SESSION_DEFAULT_TTL_SEC);
    expect(printed()).toContain(HUB_SESSION_TTL_ENV);
  });

  it('🔴 every SET-but-unusable spelling lands on the floor and is announced', () => {
    for (const bad of ['0', '-1', 'NaN', 'soon', '5', '99999999', '604801', '59']) {
      err.mockClear();
      process.env[HUB_SESSION_TTL_ENV] = bad;
      expect(hubSessionTtlSeconds(), bad).toBe(HUB_SESSION_MIN_TTL_SEC);
      expect(printed(), bad).toContain(HUB_SESSION_TTL_ENV);
    }
  });

  it('🔴 out of range is REFUSED, not silently clamped to the nearest end', () => {
    // A week + 1 second is a number nobody chose. Reading it as a week is the same silent
    // adjustment that made '0' mean 'a day' — so it gets the floor and a line, like any
    // other unusable value.
    process.env[HUB_SESSION_TTL_ENV] = String(HUB_SESSION_MAX_TTL_SEC + 1);
    expect(hubSessionTtlSeconds()).toBe(HUB_SESSION_MIN_TTL_SEC);
    expect(hubSessionTtlSeconds()).not.toBe(HUB_SESSION_MAX_TTL_SEC);
    // …while the ends themselves are perfectly usable values.
    err.mockClear();
    process.env[HUB_SESSION_TTL_ENV] = String(HUB_SESSION_MAX_TTL_SEC);
    expect(hubSessionTtlSeconds()).toBe(HUB_SESSION_MAX_TTL_SEC);
    process.env[HUB_SESSION_TTL_ENV] = String(HUB_SESSION_MIN_TTL_SEC);
    expect(hubSessionTtlSeconds()).toBe(HUB_SESSION_MIN_TTL_SEC);
    expect(err).not.toHaveBeenCalled();
  });

  it('🔴 the loud line carries the NAME of the variable and NEVER the value', () => {
    // The value is configuration; the log is read by more people than the panel. The name
    // is the whole of what a person needs in order to go and fix it.
    for (const bad of ['99999999', 'sekret-value-42']) {
      err.mockClear();
      process.env[HUB_SESSION_TTL_ENV] = bad;
      expect(hubSessionTtlSeconds(), bad).toBe(HUB_SESSION_MIN_TTL_SEC);
      const line = printed();
      expect(line, bad).toContain(HUB_SESSION_TTL_ENV);
      expect(line, bad).not.toContain(bad);
    }
  });

  it('the configured value is what a minted pass actually gets', () => {
    process.env[HUB_SESSION_TTL_ENV] = '120';
    const { token } = mintHubSession('555000111', null, JTI, BOT_TOKEN);
    const res = verifyHubSession(token, BOT_TOKEN);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claims.exp - res.claims.iat).toBe(120);
  });

  it('🔴 a broken setting shortens the pass instead of lengthening it (the direction of the fault)', () => {
    // The end-to-end shape of the same rule: with a nonsense setting in the panel, a pass
    // minted right now lives a minute — not a day.
    process.env[HUB_SESSION_TTL_ENV] = 'kill-them-all';
    const { expiresAt } = mintHubSession('555000111', null, JTI, BOT_TOKEN);
    expect(expiresAt - nowSec()).toBeLessThanOrEqual(HUB_SESSION_MIN_TTL_SEC);
  });
});

// ---------------------------------------------------------------------------------------
// FIX №1 (007, major): HUB_SESSION_TTL_SECONDS IS A REVOCATION LEVER.
// `exp` is baked in at mint time, so while verify only asked "exp <= now?", lowering the
// variable did nothing to passes ALREADY OUT — in an incident the choice was "change
// BOT_TOKEN and burn the bot" or "tolerate the thief for a day". The second refusal
// (exp - iat > the TTL configured NOW) turns the variable into a real switch.
// ---------------------------------------------------------------------------------------
describe('hub session — lowering the TTL kills passes already issued (fix №1)', () => {
  it('🔴 a pass minted at a day is refused the moment the TTL is lowered to a minute', () => {
    // Issued in peacetime, under the default day.
    const { token } = mintHubSession('555000111', 'ru', JTI, BOT_TOKEN);
    expect(reasonOf(token)).toBe('ACCEPTED');

    // The incident: the owner sets HUB_SESSION_TTL_SECONDS=60 on Vercel AND presses
    // Redeploy (on Vercel the value belongs to a deployment — see the header of
    // hub-session.ts and .env.example). No code changes, the bot token is untouched, no
    // store is consulted; what this test stands in for is the first request served after
    // that redeploy.
    process.env[HUB_SESSION_TTL_ENV] = '60';
    expect(reasonOf(token)).toBe('ttl_too_long');

    // …and a pass minted AFTER the change is fine, so the door itself still works: the
    // lever revokes the outstanding day-long passes, not the second door.
    const fresh = mintHubSession('555000111', 'ru', JTI, BOT_TOKEN);
    expect(reasonOf(fresh.token)).toBe('ACCEPTED');
    expect(fresh.expiresAt - nowSec()).toBeLessThanOrEqual(60);
  });

  it('the boundary belongs to the pass: exp - iat EXACTLY equal to the TTL still passes', () => {
    process.env[HUB_SESSION_TTL_ENV] = '3600';
    const { token } = mintHubSession('555000111', null, JTI, BOT_TOKEN, 3600);
    expect(reasonOf(token)).toBe('ACCEPTED');
    // One second longer than the setting is already a different contract.
    const overshoot = mintHubSession('555000111', null, JTI, BOT_TOKEN, 3601);
    expect(reasonOf(overshoot.token)).toBe('ttl_too_long');
  });

  it('raising the TTL back does NOT resurrect anything that had really expired', () => {
    const { token, expiresAt } = mintHubSession('555000111', null, JTI, BOT_TOKEN, 60);
    process.env[HUB_SESSION_TTL_ENV] = '604800';
    expect(reasonOf(token, BOT_TOKEN, expiresAt + 1)).toBe('expired');
  });

  it('it is the same rule the ticket has had all along (exp - iat > its own TTL)', () => {
    // Said as a test rather than as a sentence in a comment: both doors refuse an over-long
    // lifetime the same way, so neither can be "simplified" into an exception on its own.
    process.env[HUB_SESSION_TTL_ENV] = '900';
    const iat = nowSec();
    expect(reasonOf(forge({ sub: '555', lang: null, jti: JTI, iat, exp: iat + 901 }))).toBe(
      'ttl_too_long',
    );
    expect(reasonOf(forge({ sub: '555', lang: null, jti: JTI, iat, exp: iat + 900 }))).toBe(
      'ACCEPTED',
    );
  });
});

// ---------------------------------------------------------------------------------------
// FIX №7 (Хейтер, minor): we do not issue what we would not accept.
// ---------------------------------------------------------------------------------------
describe('hub session — minting refuses to hand out a pass we would reject (fix №7)', () => {
  it('🔴 a pass grown past HUB_SESSION_MAX_CHARS throws at MINT, not on the next request', () => {
    // The live shape of this: a hub-signed ticket whose language tag is ~700 characters.
    // Without the cap the exchange answered 200 with a token that every later request
    // refused — a door that opens onto a wall, and a fault that reads as the person's.
    const hugeLang = 'ru-' + 'x'.repeat(2000);
    expect(() => mintHubSession('555000111', hugeLang, JTI, BOT_TOKEN)).toThrow(
      /HUB_SESSION_MAX_CHARS/,
    );
  });

  it('a pass of ordinary size is nowhere near the cap (a guard, not a squeeze)', () => {
    const { token } = mintHubSession('9223372036854775807', 'pt-br', 'A'.repeat(86), BOT_TOKEN);
    expect(token.length).toBeLessThan(HUB_SESSION_MAX_CHARS);
    expect(reasonOf(token)).toBe('ACCEPTED');
  });
});

// ---------------------------------------------------------------------------------------
// FIX №13 (Хейтер): THE PRICE OF THE DAY IS WRITTEN DOWN, IN NUMBERS.
// The owner chose 86400 s knowingly — the number is his and this file does not argue with
// it. What was missing was the comparison SAID OUT LOUD next to it, so that re-deciding is
// possible without re-deriving it. The header of hub-session.ts now says: door 1 lives
// 900 s and is re-checked every request, door 2 lives 86400 s — 96 times longer — and is
// revoked by lowering HUB_SESSION_TTL_SECONDS (fix №1), not only by changing BOT_TOKEN.
//
// A sentence about numbers is worth nothing without a test that reddens when a number moves
// (skill comment-invariant-needs-companion-test.md). This is that test: change either
// lifetime and it fails, pointing whoever changed it at the paragraph they have just made
// untrue.
// ---------------------------------------------------------------------------------------
describe('hub session — the header states the price, and the price is checked (fix №13)', () => {
  it('🔴 door 2 lives exactly 96 times longer than door 1, as the header says', () => {
    // Door 1's lifetime is not importable — it is read inline in core/context.ts — so it
    // is read from the source, which is also the only place it could silently change.
    const contextSrc = readFileSync(new URL('./context.ts', import.meta.url), 'utf8');
    const m = /INITDATA_TTL_SECONDS \?\? '(\d+)'/.exec(contextSrc);
    expect(m, 'the Telegram door no longer states its TTL the way this test reads it').not.toBeNull();

    const initDataTtl = Number((m as RegExpExecArray)[1]);
    expect(initDataTtl).toBe(900);
    expect(HUB_SESSION_DEFAULT_TTL_SEC).toBe(86400);
    expect(HUB_SESSION_DEFAULT_TTL_SEC / initDataTtl).toBe(96);
  });

  it('and the revocation lever is a real one: the floor lets it go down to a minute', () => {
    // The paragraph promises "set it to 60 and every day-long pass is dead". That is only
    // true while 60 is actually reachable — the clamp must not have a floor above it.
    expect(HUB_SESSION_MIN_TTL_SEC).toBe(60);
    process.env[HUB_SESSION_TTL_ENV] = '60';
    expect(hubSessionTtlSeconds()).toBe(60);
  });
});

// ---------------------------------------------------------------------------------------
// FIX №4 OF THE THIRD ROUND (007, major): THE PROMISE "NO DEPLOY NEEDED" WAS FALSE ON
// VERCEL. The code does re-read process.env on every verify — but Vercel bakes environment
// values into a PARTICULAR deployment: editing the panel changes nothing for the deployment
// that is already running, and the panel itself says the change applies on the next one. On
// the worst day the owner sets 60, sees that nothing changed, concludes there is no lever —
// and goes back to "burn BOT_TOKEN", which is the thing this whole switch exists to avoid.
//
// A promise about SOMEBODY ELSE'S infrastructure is not something code can keep, and no
// behavioural test can fail on the day Vercel changes its rules (skill
// constant-for-external-provider-promise.md). What a test CAN hold is that the sentence is
// where the owner actually looks — .env.example, next to the variable — and that the old,
// false wording does not creep back. That is this block, and it is deliberately only half
// the guard; the other half is a human reading the panel.
// ---------------------------------------------------------------------------------------
describe('the revocation lever is written where the owner reads it, and honestly (fix №4)', () => {
  const envExample = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
  const sessionSrc = readFileSync(new URL('./hub-session.ts', import.meta.url), 'utf8');

  it('🔴 .env.example describes the lever at all — it used to say nothing about it', () => {
    // The variable was listed with a one-line comment about its clamp and NOTHING about
    // what it is for. The owner reads this file; the header of a .ts he does not.
    expect(envExample).toContain(HUB_SESSION_TTL_ENV);
    expect(envExample.toLowerCase()).toMatch(/revoke|revocation/);
    // The exact instruction: set 60, and redeploy.
    expect(envExample).toMatch(new RegExp(`${HUB_SESSION_TTL_ENV}=${HUB_SESSION_MIN_TTL_SEC}\\b`));
    expect(envExample.toLowerCase()).toContain('redeploy');
  });

  it('🔴 and it says what 0 does NOT do — the word a person reaches for in an incident', () => {
    expect(envExample.toLowerCase()).toMatch(/0 is not the lever/);
  });

  it('🔴 neither file promises that the panel alone is enough', () => {
    // The sentence that cost the lever its credibility. If it returns anywhere in these
    // two files, this reddens.
    for (const [name, text] of [
      ['.env.example', envExample],
      ['hub-session.ts', sessionSrc],
    ] as const) {
      expect(text.toLowerCase(), name).not.toMatch(/no deploy|without a deploy|without deploy/);
      expect(text.toLowerCase(), name).not.toMatch(/no redeploy|without a redeploy/);
    }
  });

  it('🔴 the header of hub-session.ts carries the same instruction, not a different one', () => {
    // Two places may say it; they may not say two different things.
    expect(sessionSrc.toLowerCase()).toContain('redeploy');
    expect(sessionSrc).toContain('.env.example');
  });
});
