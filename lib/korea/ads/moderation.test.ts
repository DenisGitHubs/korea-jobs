// lib/korea/ads/moderation.test.ts
//
// recordModerationExample — what the self-learning moderation set is allowed to remember.
//
// WHY THIS TEST EXISTS (007 minor). moderation_examples keeps up to 4000 characters of an ad's
// text for 180 days with NO author column — nothing links a row back to a person, so no erasure
// (neither the 12-month sweep nor an on-request deletion) can ever reach it. People type phone
// numbers and messenger handles straight into a description, so an unscrubbed copy there is an
// orphaned contact store that outlives the ad itself. The text is therefore scrubbed with the
// SAME shared scrubber the parser and the read side use, BEFORE the length cap.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = { calls: [] as { text: string; params: unknown[] }[] };
  const fakeSql = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<unknown[]> => {
    const raw = typeof strings === 'string' ? strings : strings.join(' ? ');
    state.calls.push({ text: raw.replace(/\s+/g, ' ').trim(), params });
    return Promise.resolve([]);
  };
  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));

import { recordModerationExample } from './moderation.js';

/** The text actually written into moderation_examples (2nd bound value: kind, TEXT, decision…). */
const storedText = (): string => String(h.state.calls[0]!.params[0]);

beforeEach(() => {
  h.state.calls = [];
});

describe('recordModerationExample — contacts never enter the learning set', () => {
  it('redacts a phone number typed into the ad text', async () => {
    await recordModerationExample('Работа на заводе, звоните 010-1234-5678', 'approved', null);

    expect(h.state.calls[0]!.text).toContain('insert into moderation_examples');
    expect(storedText()).not.toContain('010-1234-5678');
    expect(storedText()).toContain('[скрыто]');
    // The SHAPE of the post survives — that is what the few-shot actually calibrates on.
    expect(storedText()).toContain('Работа на заводе');
  });

  it('redacts a messenger handle and an e-mail', async () => {
    await recordModerationExample('Пишите @recruiter_kr или на hr@example.com', 'rejected', 'ads');

    const t = storedText();
    expect(t).not.toContain('@recruiter_kr');
    expect(t).not.toContain('hr@example.com');
    expect(t).toContain('[скрыто]');
  });

  it('scrubs BEFORE the 4000-char cap, so a contact cannot survive past the cut point', async () => {
    const text = 'a'.repeat(3990) + ' 010-1234-5678 хвост';
    await recordModerationExample(text, 'approved', null);

    const t = storedText();
    expect(t.length).toBeLessThanOrEqual(4000);
    expect(t).not.toContain('010-1234-5678');
  });

  it('leaves an ordinary ad untouched (nothing over-redacted)', async () => {
    const clean = 'Требуется рабочий на завод в Пусане, зарплата 2 500 000 вон, жильё есть.';
    await recordModerationExample(clean, 'approved', null);

    expect(storedText()).toBe(clean);
  });

  it('still records the decision and the reason', async () => {
    await recordModerationExample('текст', 'rejected', 'spam');
    expect(h.state.calls[0]!.params).toEqual(['текст', 'rejected', 'spam']);
  });

  it('never throws when the insert fails (it is a best-effort learning write)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = vi.fn(() => Promise.reject(new Error('db down')));
    const mod = await import('../core/db.js');
    vi.spyOn(mod, 'getSql').mockReturnValue(boom as never);

    await expect(recordModerationExample('текст', 'approved', null)).resolves.toBeUndefined();

    vi.restoreAllMocks();
    spy.mockRestore();
  });
});
