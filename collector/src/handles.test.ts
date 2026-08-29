// collector/src/handles.test.ts
//
// The author handle decides what a CARD SHOWS AS A CONTACT when the posting itself contains none
// (backend: parser/run.ts, owner rule 2026-07-19) — which is most postings. Two failures matter:
//   * sending nothing: the mechanism is dead and every such card falls back to "открыть в канале";
//   * sending the CHANNEL handle: every contact-less card gains a "contact" that is not a person
//     and cannot be written to, which is worse than an honest fallback.
// Both are pinned below.

import { describe, it, expect } from 'vitest';
import { entityUsername, senderHandle } from './handles.js';

/** GramJS entities carry a className; that is how a user is told from a channel. */
const user = (over: Record<string, unknown> = {}) => ({ className: 'User', id: 7, ...over });
const channel = (over: Record<string, unknown> = {}) => ({ className: 'Channel', id: 9, ...over });

describe('entityUsername — any entity', () => {
  it('reads the plain username in its original case', () => {
    expect(entityUsername(user({ username: 'Korea_Work' }))).toBe('Korea_Work');
    expect(entityUsername(channel({ username: 'korea_jobs' }))).toBe('korea_jobs');
  });

  it('falls back to an ACTIVE collectible username when the main one is empty', () => {
    expect(entityUsername(user({ username: null, usernames: [{ username: 'spare', active: true }] }))).toBe('spare');
    expect(entityUsername(user({ usernames: [{ username: 'old', active: false }, { username: 'now', active: true }] }))).toBe('now');
  });

  it('is null for entities without any handle and for junk', () => {
    expect(entityUsername(user())).toBeNull();
    expect(entityUsername(user({ username: '' }))).toBeNull();
    expect(entityUsername(user({ usernames: [] }))).toBeNull();
    expect(entityUsername(null)).toBeNull();
    expect(entityUsername(undefined)).toBeNull();
    expect(entityUsername('korea_work')).toBeNull();
  });
});

describe('senderHandle — only a real person becomes a contact', () => {
  it('returns the handle of a user author', () => {
    expect(senderHandle(user({ username: 'anna_hr' }))).toBe('anna_hr');
  });

  it('returns NULL for a channel author, however tempting its username looks', () => {
    // A broadcast channel is its own sender. Its @handle is not a person to write to, and putting
    // it on the card as a contact would quietly replace an honest "открыть в канале" on a large
    // share of cards.
    expect(senderHandle(channel({ username: 'korea_jobs' }))).toBeNull();
  });

  it('returns NULL for a group, an anonymous admin, or a sender we have no entity for', () => {
    expect(senderHandle({ className: 'Chat', title: 'group' })).toBeNull();
    expect(senderHandle(undefined)).toBeNull();
    expect(senderHandle(null)).toBeNull();
  });

  it('does NOT re-implement the bot rule (the backend owns it in one place)', () => {
    // A bot handle is passed through as-is; canonical.ts isLiveUserHandle is the single place that
    // decides what a bot handle means. A second copy here would be a second thing to keep in step.
    expect(senderHandle(user({ username: 'some_bot' }))).toBe('some_bot');
  });
});
