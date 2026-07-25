// lib/korea/core/start-param.test.ts
//
// parseStartParam is the ONLY place a Telegram deep-link start_param is decomposed into
// { refCode, vacancyId }. It gates referral attribution (normalizeRefCode reads refCode)
// for BOTH the mini-app auth upsert and the bot `/start` handler, so a wrong split either
// drops a legit referral or latches attribution onto garbage. These tests pin the exact
// contract shared with the front-end ("Поделиться вакансией"):
//   * bare 16-hex  -> legacy referral, unchanged;
//   * v<32hex>r<16hex> -> vacancy share carrying an inviter code;
//   * v<32hex>          -> vacancy share with no referral (degrade);
//   * garbage/absent    -> {} (fail-closed, never a partial match).

import { describe, it, expect } from 'vitest';
import { parseStartParam, normalizeRefCode, buildShareStartParam } from './start-param.js';

const REF = 'a1b2c3d4e5f60718'; // 16 hex == users.public_id
const REF2 = '00112233445566ff';
const VAC = '0f8c2a1b3d4e4f5a6b7c8d9e0f1a2b3c'; // 32 hex == UUID w/o dashes

describe('parseStartParam — legacy bare referral (unchanged)', () => {
  it('returns the 16-hex code as refCode, no vacancyId', () => {
    expect(parseStartParam(REF)).toEqual({ refCode: REF });
  });

  it('lowercases an uppercased bare code', () => {
    expect(parseStartParam(REF.toUpperCase())).toEqual({ refCode: REF });
  });

  it('trims surrounding whitespace', () => {
    expect(parseStartParam(`  ${REF}  `)).toEqual({ refCode: REF });
  });
});

describe('parseStartParam — vacancy share (v<vacancy>r<ref>)', () => {
  it('splits vacancyId and refCode from a combined link', () => {
    expect(parseStartParam(`v${VAC}r${REF}`)).toEqual({ vacancyId: VAC, refCode: REF });
  });

  it('is case-insensitive and normalizes both parts to lowercase', () => {
    expect(parseStartParam(`V${VAC.toUpperCase()}R${REF.toUpperCase()}`)).toEqual({
      vacancyId: VAC,
      refCode: REF,
    });
  });

  it('stays within Telegram limits (allowed charset, <= 512)', () => {
    const s = `v${VAC}r${REF}`;
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBeLessThanOrEqual(512);
    expect(s.length).toBe(1 + 32 + 1 + 16); // 50
  });
});

describe('parseStartParam — degradation (only one part)', () => {
  it('vacancy-only link yields vacancyId and NO refCode', () => {
    expect(parseStartParam(`v${VAC}`)).toEqual({ vacancyId: VAC });
  });

  it('bare referral still yields refCode and NO vacancyId', () => {
    expect(parseStartParam(REF2)).toEqual({ refCode: REF2 });
  });
});

describe('parseStartParam — garbage / malformed -> {}', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['non-string', 12345 as unknown as string],
    ['short hex (15)', 'a1b2c3d4e5f6071'],
    ['long hex (17)', 'a1b2c3d4e5f6071899'],
    ['non-hex chars', 'g1b2c3d4e5f60718'],
    ['ref_ office style', `ref_${REF}`],
    ['vacancy wrong length', `v${VAC}0`],
    ['ref part wrong length', `v${VAC}r${REF}00`],
    ['missing r delimiter', `v${VAC}${REF}`],
    ['bare 32-hex without v tag', VAC],
    ['injection attempt', `${REF}';drop table users;--`],
  ])('%s -> {}', (_label, input) => {
    expect(parseStartParam(input)).toEqual({});
  });
});

describe('buildShareStartParam — inverse of parseStartParam (share card link)', () => {
  const UUID = '0f8c2a1b-3d4e-4f5a-6b7c-8d9e0f1a2b3c'; // dashed UUID whose hex is VAC

  it('builds v<hex>r<ref> from a dashed UUID + valid ref code', () => {
    expect(buildShareStartParam(UUID, REF)).toBe(`v${VAC}r${REF}`);
  });

  it('builds a vacancy-only link when the ref code is absent', () => {
    expect(buildShareStartParam(UUID, null)).toBe(`v${VAC}`);
    expect(buildShareStartParam(UUID)).toBe(`v${VAC}`);
  });

  it('drops an invalid ref code but still returns the vacancy-only link', () => {
    expect(buildShareStartParam(UUID, 'not-a-ref')).toBe(`v${VAC}`);
    expect(buildShareStartParam(UUID, `${REF}00`)).toBe(`v${VAC}`);
  });

  it('lowercases and strips dashes; result stays Telegram-legal and <= 512', () => {
    const sp = buildShareStartParam(UUID.toUpperCase(), REF.toUpperCase());
    expect(sp).toBe(`v${VAC}r${REF}`);
    expect(sp).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sp!.length).toBe(50);
  });

  it('round-trips through parseStartParam', () => {
    const sp = buildShareStartParam(UUID, REF)!;
    expect(parseStartParam(sp)).toEqual({ vacancyId: VAC, refCode: REF });
  });

  it('returns null when the vacancy id is not a UUID', () => {
    expect(buildShareStartParam('v01', REF)).toBeNull();
    expect(buildShareStartParam(VAC, REF)).toBeNull(); // 32-hex without dashes is not accepted here
    expect(buildShareStartParam('', REF)).toBeNull();
  });
});

describe('normalizeRefCode — attribution input (contract preserved)', () => {
  it('bare code -> the code', () => {
    expect(normalizeRefCode(REF)).toBe(REF);
  });

  it('combined link -> embedded ref code', () => {
    expect(normalizeRefCode(`v${VAC}r${REF}`)).toBe(REF);
  });

  it('vacancy-only link -> null (no attribution)', () => {
    expect(normalizeRefCode(`v${VAC}`)).toBeNull();
  });

  it.each([null, undefined, '', 'not-a-code', `ref_${REF}`])(
    'garbage %s -> null',
    (input) => {
      expect(normalizeRefCode(input as string | null | undefined)).toBeNull();
    },
  );
});
