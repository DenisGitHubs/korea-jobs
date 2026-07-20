// lib/korea/parser/canonical.test.ts
//
// pickCanonical implements the owner rule (2026-07-20): among byte-identical reposts, send the AI
// the copy whose AUTHOR is a live Telegram user (a non-bot @username) so the card can carry a real
// DM contact — and only fall back to a bot/anonymous copy when NO copy has a live-user author.
// Within the chosen class the EARLIEST posting wins. These are pure functions (no db / no SDK).

import { describe, it, expect } from 'vitest';
import { pickCanonical, isLiveUserHandle, normalizeHandle } from './canonical.js';

// Minimal shape of the raw_messages rows pickCanonical reads (id / posted_at / sender_username).
const row = (id: string, posted_at: string | null, sender_username: string | null) => ({
  id,
  posted_at,
  sender_username,
});

describe('pickCanonical — prefer a live-user author over a bot', () => {
  it('human + bot → the human copy wins even though the bot posted earlier', () => {
    const bot = row('b', '2026-07-01T00:00:00Z', 'channel_bot'); // earliest, but a bot
    const human = row('h', '2026-07-02T00:00:00Z', 'ivan_hr'); // later, but a live user
    expect(pickCanonical([bot, human]).id).toBe('h');
    expect(pickCanonical([human, bot]).id).toBe('h'); // order-independent
  });

  it('mixed pool: a live user with NO timestamp still beats every bot; earliest live user wins', () => {
    const bot = row('bot', '2026-01-01T00:00:00Z', 'super_bot'); // oldest overall, but a bot
    const liveNoTime = row('lnt', null, 'user_a'); // live, but undated -> sorts last among live
    const liveTimed = row('lt', '2026-07-02T00:00:00Z', '@user_b'); // leading @ stripped, still live
    expect(pickCanonical([bot, liveNoTime, liveTimed]).id).toBe('lt');
  });
});

describe('pickCanonical — earliest within the chosen class', () => {
  it('two humans → the EARLIEST human wins', () => {
    const early = row('e', '2026-07-01T00:00:00Z', 'anna');
    const late = row('l', '2026-07-05T00:00:00Z', 'boris');
    expect(pickCanonical([late, early]).id).toBe('e');
  });

  it('a missing posted_at sorts LAST among the same class', () => {
    const noTime = row('n', null, 'kate');
    const timed = row('t', '2026-07-02T00:00:00Z', 'lena');
    expect(pickCanonical([noTime, timed]).id).toBe('t');
  });
});

describe('pickCanonical — fallback when no live user is present', () => {
  it('only bots → the earliest bot wins (case-insensitive bot test)', () => {
    const b1 = row('b1', '2026-07-03T00:00:00Z', 'x_bot');
    const b2 = row('b2', '2026-07-01T00:00:00Z', 'Y_BOT'); // earliest; still a bot
    expect(pickCanonical([b1, b2]).id).toBe('b2');
  });

  it('empty / null / blank usernames → the earliest copy wins (nobody is a live user)', () => {
    const a = row('a', '2026-07-04T00:00:00Z', null);
    const b = row('b', '2026-07-02T00:00:00Z', ''); // earliest
    const c = row('c', '2026-07-03T00:00:00Z', '   ');
    expect(pickCanonical([a, b, c]).id).toBe('b');
  });

  it('single-copy group returns that copy', () => {
    expect(pickCanonical([row('only', '2026-07-01T00:00:00Z', null)]).id).toBe('only');
  });
});

describe('normalizeHandle', () => {
  it('trims and strips leading @(s)', () => {
    expect(normalizeHandle('  @@ivan  ')).toBe('ivan');
    expect(normalizeHandle('@hr_ansan')).toBe('hr_ansan');
  });
  it('non-string / absent → empty string', () => {
    expect(normalizeHandle(null)).toBe('');
    expect(normalizeHandle(undefined)).toBe('');
    expect(normalizeHandle(42)).toBe('');
  });
});

describe('isLiveUserHandle', () => {
  it('a non-bot handle (with or without leading @) is a live user', () => {
    expect(isLiveUserHandle('ivan_hr')).toBe(true);
    expect(isLiveUserHandle('@ivan_hr')).toBe(true);
  });
  it('a bot handle is NOT a live user (case-insensitive, leading @ ignored)', () => {
    expect(isLiveUserHandle('news_bot')).toBe(false);
    expect(isLiveUserHandle('NEWS_BOT')).toBe(false);
    expect(isLiveUserHandle('@vacancy_BOT')).toBe(false);
  });
  it('empty / blank / non-string is NOT a live user', () => {
    expect(isLiveUserHandle('')).toBe(false);
    expect(isLiveUserHandle('   ')).toBe(false);
    expect(isLiveUserHandle(null)).toBe(false);
    expect(isLiveUserHandle(undefined)).toBe(false);
  });
});
