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
import {
  parseStartParam,
  normalizeRefCode,
  normalizeAcqSource,
  buildShareStartParam,
  buildSourceStartParam,
} from './start-param.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// Acquisition label `ads_<slug>` / `s_<slug>` (Telegram Ads «URL to promote», 2026-08-01)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseStartParam — acquisition label', () => {
  it('reads the EXACT label the ads brief tells the owner to paste', () => {
    // _docs/ads/telegram-ads-brief.md §4 — these three strings are already in the owner's hands.
    expect(parseStartParam('ads_ru1')).toEqual({ source: 'ads_ru1' });
    expect(parseStartParam('ads_uz1')).toEqual({ source: 'ads_uz1' });
    expect(parseStartParam('ads_ru2')).toEqual({ source: 'ads_ru2' });
  });

  it('keeps the WHOLE param as the label (what he typed is what /stats prints)', () => {
    expect(parseStartParam('s_flyer')).toEqual({ source: 's_flyer' });
    expect(parseStartParam('s_blogger_ivan')).toEqual({ source: 's_blogger_ivan' });
  });

  it('lowercases it (the cabinet may capitalise, the report must not split)', () => {
    expect(parseStartParam('ADS_RU1')).toEqual({ source: 'ads_ru1' });
  });

  it('folds a dash to an underscore so one campaign cannot split into two buckets', () => {
    expect(parseStartParam('ads_ru-1')).toEqual({ source: 'ads_ru_1' });
    expect(parseStartParam('ads_ru-1')).toEqual(parseStartParam('ads_ru_1'));
  });

  it('trims surrounding whitespace like the other shapes', () => {
    expect(parseStartParam('  ads_uz1  ')).toEqual({ source: 'ads_uz1' });
  });

  it('accepts the shortest (4) and the longest (32) allowed label', () => {
    expect(parseStartParam('s_ru')).toEqual({ source: 's_ru' });
    const max = `ads_${'a'.repeat(28)}`; // exactly 32
    expect(max.length).toBe(32);
    expect(parseStartParam(max)).toEqual({ source: max });
  });

  it('the real campaign links stay inside BOTH Telegram limits (64 for ?start=, 512 for startapp)', () => {
    for (const sp of ['ads_ru1', 'ads_uz1']) {
      expect(sp).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(sp.length).toBeLessThanOrEqual(64);
    }
  });

  it.each([
    ['bare prefix', 'ads_'],
    ['bare short prefix', 's_'],
    ['too short', 's_a'],
    ['33 chars', `ads_${'a'.repeat(29)}`],
    ['underscore right after the prefix', 'ads__ru1'],
    ['dash right after the prefix', 's_-ads'],
    ['cyrillic label', 'ads_реклама'],
    ['space inside', 'ads_ru 1'],
    ['dot inside', 'ads_ru.1'],
    ['no underscore after the prefix', 'adsru1'],
    ['unknown prefix', 'src_ru1'],
    ['bare word, no prefix at all', 'reklama'],
    ['injection attempt', "ads_ru';drop table users;--"],
  ])('%s -> {} (a typo must produce NO label, never a junk bucket)', (_label, input) => {
    expect(parseStartParam(input)).toEqual({});
  });
});

describe('parseStartParam — the three shapes never mix', () => {
  it('a campaign label yields NO refCode and NO vacancyId', () => {
    const p = parseStartParam('ads_ru1');
    expect(p.refCode).toBeUndefined();
    expect(p.vacancyId).toBeUndefined();
    expect(normalizeRefCode('ads_ru1')).toBeNull();
  });

  it('a bare referral code yields NO source (16 hex can never look like a label)', () => {
    expect(parseStartParam(REF).source).toBeUndefined();
    expect(normalizeAcqSource(REF)).toBeNull();
  });

  it('a vacancy share (with and without a ref) yields NO source', () => {
    expect(parseStartParam(`v${VAC}r${REF}`).source).toBeUndefined();
    expect(parseStartParam(`v${VAC}`).source).toBeUndefined();
    expect(normalizeAcqSource(`v${VAC}r${REF}`)).toBeNull();
  });

  it('a label can never be read as hex: `_` is not a hex digit, no prefix starts with v', () => {
    for (const s of ['ads_ru1', 's_flyer']) {
      expect(s).not.toMatch(/^[0-9a-f]{16}$/i);
      expect(s).not.toMatch(/^v[0-9a-f]{32}/i);
    }
  });

  it('a 16-char string that happens to start with s_ is a label, not a public_id', () => {
    // s_ + 14 hex chars = 16 chars overall — but the `_` disqualifies it as a public_id.
    expect(parseStartParam('s_a1b2c3d4e5f607')).toEqual({ source: 's_a1b2c3d4e5f607' });
    expect(normalizeRefCode('s_a1b2c3d4e5f607')).toBeNull();
  });
});

describe('normalizeAcqSource — the sole input of the users.acq_source write', () => {
  it('label -> label', () => {
    expect(normalizeAcqSource('ads_ru1')).toBe('ads_ru1');
  });

  it.each([null, undefined, '', '   ', 'not-a-label', REF, `v${VAC}r${REF}`, 'ads_'])(
    'garbage %s -> null (nothing is ever stored)',
    (input) => {
      expect(normalizeAcqSource(input as string | null | undefined)).toBeNull();
    },
  );
});

describe('buildSourceStartParam — mint the exact string for the ad cabinet', () => {
  it('keeps an already-prefixed campaign name as is', () => {
    expect(buildSourceStartParam('ads_ru1')).toBe('ads_ru1');
    expect(buildSourceStartParam('s_flyer')).toBe('s_flyer');
  });

  it('gives an unprefixed name the generic `s_` instead of dropping it', () => {
    expect(buildSourceStartParam('flyer')).toBe('s_flyer');
    expect(buildSourceStartParam('  Blogger Ivan ')).toBe('s_blogger_ivan');
    expect(buildSourceStartParam('blog.ivan')).toBe('s_blog_ivan');
  });

  it('round-trips through parseStartParam', () => {
    for (const name of ['ads_ru1', 'flyer', 'ads_uz1']) {
      const sp = buildSourceStartParam(name)!;
      expect(parseStartParam(sp)).toEqual({ source: sp });
    }
  });

  it.each(['', ' ', 'a', 'реклама', 'a'.repeat(33), 'ads;drop'])('rejects %s -> null', (input) => {
    expect(buildSourceStartParam(input)).toBeNull();
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
