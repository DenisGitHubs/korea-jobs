// lib/korea/parser/run.test.ts
//
// Pins the DEFENSE-IN-DEPTH invariant behind the «Не проверено» tab (Censor «остаток-3»).
//
// The «первая судимая ИИ копия» discriminator is: an AI-JUDGED reject/low_confidence row carries a
// NON-NULL raw_messages.confidence, while a pre-AI cache-skip (verdict-cache replay) writes NO
// confidence and leaves it NULL. raw/read.ts, admin/stats.ts and raw/reveal.ts all key the visible
// low_confidence arm on `confidence IS NOT NULL`, so the first (judged) copy shows and cached repeats
// are hidden. That whole scheme silently breaks if the model ever returns is_vacancy=true with
// low_confidence but OMITS the confidence number — the naive `it.confidence ?? null` would then write
// NULL and the judged row would be indistinguishable from a cache-skip and vanish from the tab.
//
// aiJudgedConfidence() is the write-path guard that closes that hole: any AI-judged row gets a
// non-NULL confidence (a missing/non-finite value defaults to 0, still under parser_min_confidence).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// runParse is driven below against a fake database, config and model (no network): the queries are
// routed by their text, everything else answers []. The pure helpers above need none of it.
const h = vi.hoisted(() => {
  const state = {
    pending: [] as Record<string, unknown>[],
    cfg: {} as Record<string, unknown>,
    calls: [] as { text: string; params: unknown[] }[],
    reply: { items: [] as unknown[] },
    failStats: false,
  };
  const create = vi.fn(async () => ({
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    content: [{ type: 'text', text: JSON.stringify(state.reply) }],
  }));
  const fakeSql = (strings: TemplateStringsArray | string, ...params: unknown[]): Promise<unknown[]> => {
    const text = (typeof strings === 'string' ? strings : strings.join(' ? ')).replace(/\s+/g, ' ').trim();
    state.calls.push({ text, params });
    if (text.includes('from raw_messages r left join sources')) return Promise.resolve(state.pending);
    if (text.includes('insert into ai_reject_stats') && state.failStats) {
      return Promise.reject(new Error('stats table gone'));
    }
    if (text.includes('insert into vacancies')) return Promise.resolve([{ id: 'v-1', inserted: true }]);
    return Promise.resolve([]);
  };
  return { state, create, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('../config.js', () => ({
  getConfigNumber: async (k: string, fb: number) => (h.state.cfg[k] as number | undefined) ?? fb,
  getConfigString: async (_k: string, fb: string) => fb,
  getConfigBool: async (k: string, fb: boolean) => (h.state.cfg[k] as boolean | undefined) ?? fb,
}));
vi.mock('../ai-usage.js', () => ({ recordAiUsage: vi.fn(async () => {}) }));
// Pass-through to the real rules; one test makes the shadow matcher throw once.
vi.mock('./spamfilter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./spamfilter.js')>();
  return { ...real, observedHits: vi.fn(real.observedHits) };
});
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: h.create };
  },
}));

import {
  aiJudgedConfidence,
  aiCallDecision,
  seoulHour,
  inQuietHours,
  createRunRecorder,
  runParse,
  type AiCallPolicy,
} from './run.js';
import { observedHits } from './spamfilter.js';

describe('aiJudgedConfidence — an AI-judged row is NEVER written with a NULL confidence', () => {
  it('passes a finite number through unchanged (incl. 0 and sub-threshold values)', () => {
    expect(aiJudgedConfidence(0.4)).toBe(0.4);
    expect(aiJudgedConfidence(0.59)).toBe(0.59);
    expect(aiJudgedConfidence(0)).toBe(0);
    expect(aiJudgedConfidence(1)).toBe(1);
  });

  it('defaults a MISSING confidence (model omitted the field) to 0 — never NULL/undefined', () => {
    expect(aiJudgedConfidence(undefined)).toBe(0);
    expect(aiJudgedConfidence(null)).toBe(0);
  });

  it('defaults a non-finite / wrong-typed confidence to 0 (defense in depth)', () => {
    expect(aiJudgedConfidence(NaN)).toBe(0);
    expect(aiJudgedConfidence(Infinity)).toBe(0);
    expect(aiJudgedConfidence('0.5')).toBe(0);
    expect(aiJudgedConfidence({})).toBe(0);
  });

  it('the result is ALWAYS a real number (so the DB write is never NULL)', () => {
    for (const v of [undefined, null, NaN, 'x', {}, [], 0.42, 0]) {
      const c = aiJudgedConfidence(v);
      expect(typeof c).toBe('number');
      expect(Number.isFinite(c)).toBe(true);
      expect(c).not.toBeNull();
    }
  });
});

describe('«Не проверено» visibility — AI-judged low_confidence shows, cache-skip is hidden', () => {
  // Mirror of the read-side whitelist arm for a skipped row: raw/read.ts (~135), admin/stats.ts
  // (~105) and raw/reveal.ts (~66) all show a low_confidence row ONLY when confidence IS NOT NULL.
  const shownInUnverified = (row: {
    status: string;
    reject_reason: string | null;
    confidence: number | null;
  }): boolean =>
    row.status === 'skipped' &&
    row.reject_reason === 'low_confidence' &&
    row.confidence !== null;

  it('a low_confidence row the model judged but WITHOUT a confidence still shows (confidence→0)', () => {
    // Model reply: is_vacancy true, low confidence, but the confidence NUMBER is missing.
    const modelItem: { is_vacancy: boolean; confidence?: number } = { is_vacancy: true };
    const row = {
      status: 'skipped',
      reject_reason: 'low_confidence',
      confidence: aiJudgedConfidence(modelItem.confidence), // == the run.ts write path
    };
    expect(row.confidence).not.toBeNull();
    expect(row.confidence).toBe(0);
    expect(shownInUnverified(row)).toBe(true); // the AI-judged first copy is VISIBLE
  });

  it('a pre-AI cache-skip (confidence left NULL) stays HIDDEN — the discriminator holds', () => {
    // verdict-cache replay writes reject_reason='low_confidence' but NO confidence column → NULL.
    const cacheSkipRow = { status: 'skipped', reject_reason: 'low_confidence', confidence: null };
    expect(shownInUnverified(cacheSkipRow)).toBe(false);
  });

  it('a low_confidence row WITH a real model confidence shows as before (no regression)', () => {
    const row = {
      status: 'skipped',
      reject_reason: 'low_confidence',
      confidence: aiJudgedConfidence(0.45),
    };
    expect(row.confidence).toBe(0.45);
    expect(shownInUnverified(row)).toBe(true);
  });
});

// ── Call the model only when it is worth it (owner decision 2026-10-24) ─────────────────────────────
const POLICY: AiCallPolicy = { minBatch: 20, maxWaitMinutes: 30, quietStartHour: 0, quietEndHour: 5 };
const DAY = Date.parse('2026-10-24T03:00:00Z'); // 12:00 in Seoul
const NIGHT = Date.parse('2026-10-24T16:30:00Z'); // 01:30 in Seoul
const MIN = 60_000;

describe('seoulHour / inQuietHours', () => {
  it('Seoul is UTC+9 with no daylight saving', () => {
    expect(seoulHour(DAY)).toBe(12);
    expect(seoulHour(NIGHT)).toBe(1);
    expect(seoulHour(Date.parse('2026-07-01T15:00:00Z'))).toBe(0); // summer: still +9
  });
  it('[start, end) — start inclusive, end exclusive', () => {
    expect(inQuietHours(0, 0, 5)).toBe(true);
    expect(inQuietHours(4, 0, 5)).toBe(true);
    expect(inQuietHours(5, 0, 5)).toBe(false);
    expect(inQuietHours(23, 0, 5)).toBe(false);
  });
  it('a window across midnight wraps; start === end means no night at all', () => {
    expect(inQuietHours(23, 22, 5)).toBe(true);
    expect(inQuietHours(3, 22, 5)).toBe(true);
    expect(inQuietHours(12, 22, 5)).toBe(false);
    expect(inQuietHours(3, 4, 4)).toBe(false);
  });
});

describe('aiCallDecision', () => {
  it('waits while the batch is small and the oldest is fresh', () => {
    expect(aiCallDecision(3, DAY - 5 * MIN, DAY, POLICY)).toBe('wait');
    expect(aiCallDecision(19, DAY - 29 * MIN, DAY, POLICY)).toBe('wait');
  });
  it('calls when min_batch messages are waiting', () => {
    expect(aiCallDecision(20, DAY - 1 * MIN, DAY, POLICY)).toBe('call');
  });
  it('calls when the oldest has waited max_wait minutes', () => {
    expect(aiCallDecision(1, DAY - 30 * MIN, DAY, POLICY)).toBe('call');
  });
  it('an unknown fetch time counts as waited forever', () => {
    expect(aiCallDecision(1, null, DAY, POLICY)).toBe('call');
  });
  it('night beats both triggers', () => {
    expect(aiCallDecision(200, NIGHT - 300 * MIN, NIGHT, POLICY)).toBe('night');
  });
  it('the first morning hour calls again', () => {
    const five = Date.parse('2026-10-24T20:00:00Z'); // 05:00 Seoul
    expect(aiCallDecision(40, five - 300 * MIN, five, POLICY)).toBe('call');
  });
});

describe('createRunRecorder — the end-of-pass journal flush', () => {
  const row = (id: string) => ({ id, text: `text ${id}`, posted_at: null, source_username: 'chan' });

  it('writes a shadow sample + one counter per rule id, only for a SETTLED watched row', async () => {
    const write = vi.fn(async () => {});
    const rec = createRunRecorder(write);
    rec.watch(row('a'), ['o3', 'o5']);
    rec.watch(row('b'), ['o9']); // never settled (still waiting for the model) -> not written
    rec.settle('a', 'vacancy', 0.9);
    rec.settle('c', 'duplicate'); // never watched -> not written
    await rec.flush();
    const [counts, samples] = write.mock.calls[0]! as unknown as [Map<string, number>, { reason: string }[]];
    expect([...counts]).toEqual([
      ['shadow:o3|vacancy', 1],
      ['shadow:o5|vacancy', 1],
    ]);
    expect(samples).toEqual([
      { reason: 'shadow:o3+o5|vacancy', confidence: 0.9, postedAt: null, text: 'text a', sourceNote: 'chan' },
    ]);
  });

  it('counts the live pre-filter rule always, keeps its text only when asked', async () => {
    const write = vi.fn(async () => {});
    const rec = createRunRecorder(write);
    rec.prefilter(row('x'), 'p3', false);
    rec.prefilter(row('y'), 'p3', false);
    rec.prefilter(row('z'), 'ruble', true);
    await rec.flush();
    const [counts, samples] = write.mock.calls[0]! as unknown as [Map<string, number>, { reason: string }[]];
    expect(counts.get('prefilter:p3')).toBe(2);
    expect(counts.get('prefilter:ruble')).toBe(1);
    expect(samples.map((s) => s.reason)).toEqual(['prefilter:ruble']);
  });

  it('full text only for vacancy / low_confidence / error — and its contacts are masked', async () => {
    const write = vi.fn(async () => {});
    const rec = createRunRecorder(write);
    const withContacts = (id: string) => ({
      id,
      text: 'Завод, 2 400 000 вон. Звонить 010-1234-5678, телеграм @hr_boss_kr, t.me/hrchan, kakao id: worker2025',
      posted_at: null,
      source_username: 'chan',
    });
    for (const id of ['v', 'l', 'e']) rec.watch(withContacts(id), ['o5']);
    rec.settle('v', 'vacancy', 0.9);
    rec.settle('l', 'low_confidence', 0.4);
    rec.settle('e', 'error');
    await rec.flush();
    const [counts, samples] = write.mock.calls[0]! as unknown as [Map<string, number>, { reason: string; text: string }[]];
    expect([...counts.keys()]).toEqual(['shadow:o5|vacancy', 'shadow:o5|low_confidence', 'shadow:o5|error']);
    expect(samples.map((s) => s.reason)).toEqual(['shadow:o5|vacancy', 'shadow:o5|low_confidence', 'shadow:o5|error']);
    for (const s of samples) {
      expect(s.text).toContain('2 400 000 вон'); // the pay survives
      expect(s.text).not.toMatch(/1234|hr_boss_kr|t\.me|worker2025/);
      expect(s.text).toContain('[скрыто]');
    }
  });

  it('a model reject, a cache replay and a duplicate are COUNTED only — no text kept', async () => {
    const write = vi.fn(async () => {});
    const rec = createRunRecorder(write);
    for (const id of ['r', 'c', 'd']) rec.watch(row(id), ['o5']);
    rec.settle('r', 'not_vacancy', 0.95);
    rec.settle('c', 'cache:spam');
    rec.settle('d', 'duplicate');
    await rec.flush();
    const [counts, samples] = write.mock.calls[0]! as unknown as [Map<string, number>, unknown[]];
    expect([...counts]).toEqual([
      ['shadow:o5|not_vacancy', 1],
      ['shadow:o5|cache:spam', 1],
      ['shadow:o5|duplicate', 1],
    ]);
    expect(samples).toEqual([]);
  });

  it('a failing writer never throws out of flush', async () => {
    const rec = createRunRecorder(async () => {
      throw new Error('db down');
    });
    rec.watch(row('a'), ['o1a']);
    rec.settle('a', 'not_vacancy');
    await expect(rec.flush()).resolves.toBeUndefined();
  });
});

describe('runParse — free stages over the window, the model only when worth it', () => {
  const row = (i: number, text: string, fetchedMinAgo: number, now: number) => ({
    id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    text,
    source_id: '11111111-1111-1111-1111-111111111111',
    posted_at: new Date(now - 60 * MIN).toISOString(),
    fetched_at: new Date(now - fetchedMinAgo * MIN).toISOString(),
    sender_username: null,
    tg_message_id: null,
    source_title: null,
    source_notes: null,
    source_username: 'chan',
  });
  const job = (i: number) => `Завод в Ансане, нужен рабочий на линию номер ${i}, оплата 2 400 000 вон, общежитие есть`;
  const SPAM = 'Меняю крипту на воны, быстро и надёжно, пишите';
  const SHADOW = 'Работа онлайн для всех, 2 400 000 вон в месяц, обучение с нуля, пишите в лс';

  const sentToModel = (): unknown[] => {
    const body = (h.create.mock.calls.at(-1) as unknown as [{ messages: { content: string }[] }])[0];
    return (JSON.parse(body.messages[0]!.content) as { messages: unknown[] }).messages;
  };
  const statsWrites = () => h.state.calls.filter((c) => c.text.includes('insert into ai_reject_stats'));
  const sampleWrites = () => h.state.calls.filter((c) => c.text.includes('insert into ai_reject_samples'));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    h.state.calls = [];
    h.state.cfg = {};
    h.state.reply = { items: [] };
    h.state.failStats = false;
    h.create.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('WAIT: a small fresh queue is not sent; processed counts only the free work', async () => {
    vi.setSystemTime(DAY);
    h.state.pending = [row(1, SPAM, 5, DAY), row(2, job(2), 5, DAY), row(3, job(3), 4, DAY)];
    const r = await runParse();
    expect(h.create).not.toHaveBeenCalled();
    expect(r).toEqual({ processed: 1, vacancies: 0 }); // the spam row only
  });

  it('NIGHT (Seoul): no call even for a full, old queue', async () => {
    vi.setSystemTime(NIGHT);
    h.state.pending = Array.from({ length: 25 }, (_, i) => row(i + 1, job(i + 1), 120, NIGHT));
    const r = await runParse();
    expect(h.create).not.toHaveBeenCalled();
    expect(r).toEqual({ processed: 0, vacancies: 0 });
  });

  it('OLDEST WAITED: one message 30+ min old is sent alone', async () => {
    vi.setSystemTime(DAY);
    h.state.pending = [row(1, job(1), 31, DAY)];
    h.state.reply = { items: [{ id: '0', is_vacancy: false, reject_reason: 'not_vacancy', confidence: 0.9 }] };
    const r = await runParse();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(sentToModel()).toHaveLength(1);
    expect(r.processed).toBe(1);
  });

  it('FULL BATCH: 25 waiting -> the model gets exactly parser_batch_size, the rest stays pending', async () => {
    vi.setSystemTime(DAY);
    h.state.pending = Array.from({ length: 25 }, (_, i) => row(i + 1, job(i + 1), 2, DAY));
    const r = await runParse();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(sentToModel()).toHaveLength(20);
    // No reply items -> the 20 sent rows become 'no_parser_output' errors; the other 5 are untouched.
    expect(r.processed).toBe(20);
    const touched = h.state.calls
      .filter((c) => c.text.includes("error='no_parser_output'"))
      .map((c) => c.params.at(-1));
    expect(touched).toHaveLength(20);
    expect(touched).not.toContain(row(21, '', 0, DAY).id);
  });

  it('the free window is 200 rows, not the model batch', async () => {
    vi.setSystemTime(DAY);
    h.state.pending = [row(1, job(1), 1, DAY)];
    await runParse();
    const select = h.state.calls.find((c) => c.text.includes('from raw_messages r left join sources'))!;
    expect(select.params.at(-1)).toBe(200);
  });

  it('SHADOW: a rule hit is written with the outcome; the live pre-filter rule is counted', async () => {
    vi.setSystemTime(DAY);
    h.state.pending = [row(1, SPAM, 40, DAY), row(2, SHADOW, 40, DAY)];
    h.state.reply = { items: [{ id: '0', is_vacancy: true, confidence: 0.92, work_type: 'factory', gender: 'any' }] };
    const r = await runParse();
    expect(r).toEqual({ processed: 2, vacancies: 1 });
    const [reasons, ns] = statsWrites()[0]!.params as [string[], number[]];
    expect(reasons).toContain('shadow:o5|vacancy');
    expect(reasons.some((x) => /^prefilter:p\d+$/.test(x))).toBe(true);
    expect(ns.every((n) => n === 1)).toBe(true);
    const sample = sampleWrites()[0]!.params as [string[], (number | null)[], unknown[], string[], string[]];
    expect(sample[0]).toEqual(['shadow:o5|vacancy']); // spam text NOT sampled: reject_log_enabled is off
    expect(sample[1]).toEqual([0.92]);
    expect(sample[3]).toEqual([SHADOW]);
    expect(sample[4]).toEqual(['chan']);
  });

  it('a throwing shadow rule never breaks the live pass: the message goes on as "no shadow hit"', async () => {
    vi.setSystemTime(DAY);
    vi.mocked(observedHits).mockImplementationOnce(() => {
      throw new Error('bad shadow regex');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.state.pending = [row(1, SHADOW, 40, DAY)];
    h.state.reply = { items: [{ id: '0', is_vacancy: true, confidence: 0.92, work_type: 'factory', gender: 'any' }] };
    try {
      const r = await runParse();
      expect(r).toEqual({ processed: 1, vacancies: 1 });
      expect(sentToModel()).toHaveLength(1);
      expect(statsWrites()).toHaveLength(0); // the hit was lost, so nothing shadow-side to write
      expect(err).toHaveBeenCalledWith(expect.stringContaining('shadow rules failed'), 'bad shadow regex');
    } finally {
      err.mockRestore();
    }
  });

  it('SHADOW + reject_log_enabled: the pre-filter text is sampled too', async () => {
    vi.setSystemTime(DAY);
    h.state.cfg = { reject_log_enabled: true };
    h.state.pending = [row(1, SPAM, 1, DAY)];
    await runParse();
    const sample = sampleWrites()[0]!.params as [string[]];
    expect(sample[0]).toHaveLength(1);
    expect(sample[0][0]).toMatch(/^prefilter:p\d+$/);
  });

  it('SHADOW: a row still waiting for the model is NOT written yet', async () => {
    vi.setSystemTime(DAY);
    h.state.pending = [row(1, SHADOW, 3, DAY)];
    await runParse();
    expect(h.create).not.toHaveBeenCalled();
    expect(statsWrites()).toHaveLength(0);
    expect(sampleWrites()).toHaveLength(0);
  });

  it('a journal fault never changes the pass result', async () => {
    vi.setSystemTime(DAY);
    h.state.failStats = true;
    h.state.pending = [row(1, SPAM, 1, DAY), row(2, SHADOW, 40, DAY)];
    h.state.reply = { items: [{ id: '0', is_vacancy: true, confidence: 0.92, work_type: 'factory', gender: 'any' }] };
    await expect(runParse()).resolves.toEqual({ processed: 2, vacancies: 1 });
  });
});
