// lib/korea/core/auth.test.ts
//
// verifyInitData is the HMAC-SHA256 gate in front of EVERY mini-app endpoint (authenticate()
// calls it before trusting any user id), yet had 0 tests. This suite drives it with a REAL,
// self-generated Telegram initData signature — no mock of crypto — so the positive case proves
// the whole algorithm, not a stub:
//   secret     = HMAC_SHA256(key="WebAppData", msg=botToken)
//   data_check = every "k=v" EXCEPT `hash`, sorted (string sort of the "k=v" lines), joined by "\n"
//   expected   = HMAC_SHA256(key=secret, msg=data_check), hex   (compared constant-time)
//   reject if  now - auth_date > ttlSec
// We pin the exact reason codes from auth.ts (missing_initdata / malformed / bad_hash / expired)
// and the bigint-safe telegramId extraction (id read from raw JSON BEFORE parse, no 2^53 rounding).

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyInitData } from './auth.js';

const BOT_TOKEN = '123456:AA_test_bot_token_for_unit_tests_only';

/** Sign a set of DECODED fields exactly as auth.ts does (sort the "k=v" lines, not just keys). */
function signHash(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  pairs.sort();
  const dataCheck = pairs.join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secret).update(dataCheck).digest('hex');
}

/** Serialize fields (+ a hash) into a raw initData query string, URL-encoding each value so that
 *  URLSearchParams inside verifyInitData decodes back to the exact value we signed. */
function toInitData(fields: Record<string, string>, hash: string): string {
  const parts = Object.entries(fields).map(
    ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
  );
  parts.push(`hash=${hash}`);
  return parts.join('&');
}

/** A correctly-signed initData over `fields`. */
function validInitData(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  return toInitData(fields, signHash(fields, botToken));
}

const nowSec = () => Math.floor(Date.now() / 1000);
const userJson = (id: string | number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, first_name: 'Test', last_name: 'User', username: 'tester', language_code: 'ru', ...extra });

describe('verifyInitData — valid signature (real HMAC end-to-end)', () => {
  it('accepts a correctly-signed, fresh payload and returns the identity', () => {
    const fields = {
      user: userJson(123456789, { allows_write_to_pm: true }),
      auth_date: String(nowSec()),
      query_id: 'AAH_test_query_id',
    };
    const res = verifyInitData(validInitData(fields), BOT_TOKEN, 900);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.identity.telegramId).toBe('123456789');
    expect(res.identity.username).toBe('tester');
    expect(res.identity.firstName).toBe('Test');
    expect(res.identity.lastName).toBe('User');
    expect(res.identity.languageCode).toBe('ru');
    expect(res.identity.allowsWriteToPm).toBe(true);
  });

  it('reads telegramId as an EXACT decimal string > 2^53 (no JSON.parse rounding)', () => {
    const big = '9007199254740993'; // 2^53 + 1 — would round to ...992 under a naive JSON.parse
    const fields = { user: userJson(Number(big) /* raw JSON still prints the exact int */), auth_date: String(nowSec()) };
    // Build the user value with the literal big int in the JSON text so the pre-parse regex sees it.
    fields.user = `{"id":${big},"first_name":"Big"}`;
    const res = verifyInitData(validInitData(fields), BOT_TOKEN, 900);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.identity.telegramId).toBe(big);
  });

  it('leaves allowsWriteToPm null when the field is absent (unknown, NOT false)', () => {
    const fields = { user: `{"id":42,"first_name":"NoFlag"}`, auth_date: String(nowSec()) };
    const res = verifyInitData(validInitData(fields), BOT_TOKEN, 900);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.identity.allowsWriteToPm).toBeNull();
  });

  it('surfaces start_param when present', () => {
    const fields = { user: userJson(7), auth_date: String(nowSec()), start_param: 'abc123' };
    const res = verifyInitData(validInitData(fields), BOT_TOKEN, 900);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.identity.startParam).toBe('abc123');
  });
});

describe('verifyInitData — tampering → bad_hash', () => {
  const base = () => ({ user: userJson(555), auth_date: String(nowSec()), query_id: 'q1' });

  it('rejects a swapped hash', () => {
    const fields = base();
    const good = signHash(fields);
    // flip the first hex nibble but keep it a valid 64-hex string
    const bad = (good[0] === 'a' ? 'b' : 'a') + good.slice(1);
    const res = verifyInitData(toInitData(fields, bad), BOT_TOKEN, 900);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_hash');
  });

  it('rejects a mutated field value under the original hash (auth_date)', () => {
    const fields = base();
    const hash = signHash(fields);
    const tampered = { ...fields, auth_date: String(nowSec() - 5) }; // any change breaks the check
    const res = verifyInitData(toInitData(tampered, hash), BOT_TOKEN, 900);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_hash');
  });

  it('rejects a mutated user payload under the original hash', () => {
    const fields = base();
    const hash = signHash(fields);
    const tampered = { ...fields, user: userJson(999) };
    const res = verifyInitData(toInitData(tampered, hash), BOT_TOKEN, 900);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_hash');
  });

  it('rejects an INJECTED extra field not covered by the signature', () => {
    const fields = base();
    const hash = signHash(fields); // signed WITHOUT chat_instance
    const withExtra = { ...fields, chat_instance: '-100999' }; // now present -> included in data_check
    const res = verifyInitData(toInitData(withExtra, hash), BOT_TOKEN, 900);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_hash');
  });

  it('rejects a payload signed with a DIFFERENT bot token', () => {
    const fields = base();
    const raw = validInitData(fields, 'other:WRONG_bot_token');
    const res = verifyInitData(raw, BOT_TOKEN, 900);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_hash');
  });
});

describe('verifyInitData — expiry (checked AFTER the hash)', () => {
  it('rejects a validly-signed but stale payload with `expired`', () => {
    const fields = { user: userJson(1), auth_date: String(nowSec() - 10_000) };
    const res = verifyInitData(validInitData(fields), BOT_TOKEN, 900); // 10000s > 900s ttl
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('expired');
  });

  it('accepts a validly-signed payload inside the ttl window', () => {
    const fields = { user: userJson(1), auth_date: String(nowSec() - 100) };
    expect(verifyInitData(validInitData(fields), BOT_TOKEN, 900).ok).toBe(true);
  });
});

describe('verifyInitData — malformed / missing', () => {
  it('missing_initdata for an empty string', () => {
    const res = verifyInitData('', BOT_TOKEN, 900);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('missing_initdata');
  });

  it('malformed when the hash param is absent', () => {
    const raw = `user=${encodeURIComponent(userJson(1))}&auth_date=${nowSec()}`;
    const res = verifyInitData(raw, BOT_TOKEN, 900);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed');
  });

  it('malformed when the hash is not 64 hex chars', () => {
    const raw = `user=${encodeURIComponent(userJson(1))}&auth_date=${nowSec()}&hash=deadbeef`;
    const res = verifyInitData(raw, BOT_TOKEN, 900);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed');
  });

  it('malformed when the user field is missing (hash valid over the rest)', () => {
    const fields = { auth_date: String(nowSec()), query_id: 'q' }; // no user
    const res = verifyInitData(validInitData(fields), BOT_TOKEN, 900);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed');
  });

  it('malformed when the user JSON carries no integer id', () => {
    const fields = { user: `{"first_name":"NoId"}`, auth_date: String(nowSec()) };
    const res = verifyInitData(validInitData(fields), BOT_TOKEN, 900);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed');
  });

  it('malformed when auth_date is missing (checked before user, so not "expired")', () => {
    const fields = { user: userJson(1), query_id: 'q' }; // no auth_date
    const res = verifyInitData(validInitData(fields), BOT_TOKEN, 900);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed');
  });

  it('throws only on the programming-error case of an empty botToken', () => {
    expect(() => verifyInitData('user=x&hash=' + 'a'.repeat(64), '', 900)).toThrow(/botToken/);
  });
});
