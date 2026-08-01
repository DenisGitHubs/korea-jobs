// lib/korea/scheduled/run.test.ts
//
// The publishing worker, against an in-memory Postgres double that models the ONE thing the whole
// design rests on: PRIMARY KEY (schedule_id, run_no) on scheduled_post_runs. The fake enforces the
// conflict exactly like the real table, so "claim first, publish second" is really tested and not
// just described.
//
// What is pinned here:
//   * a duplicated tick / a concurrent invocation NEVER publishes the same run twice;
//   * a run that published but lost its bookkeeping is HEALED from the journal, not republished;
//   * kind='promo' is published with promo=true and notify_pending=FALSE — a paid placement can
//     never enter the notify queue, whatever the schedule says;
//   * a repeat publishes a NEW card and ARCHIVES the previous one (no re-dating, no duplicates);
//   * a failure is recorded (last_error), retried, and parked as 'failed' after N attempts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHED_ID = '11111111-2222-3333-4444-555555555555';

/** Positions of the values bound by publishRun's INSERT (see scheduled/run.ts). */
const AD = {
  citySlug: 0,
  createdBy: 1,
  cityText: 2,
  workType: 3,
  title: 4,
  description: 5,
  contactRaw: 6,
  contactKind: 7,
  mediaId: 8,
  promo: 9,
  ttlDays: 10,
  notifyPending: 11,
} as const;

interface Sched {
  id: string;
  kind: string;
  payload: unknown;
  media_id: string | null;
  created_by: string | null;
  total_runs: number;
  done_runs: number;
  notify: boolean;
  status: string;
  next_run_at: string | null;
  interval_minutes: number | null;
  fail_count: number;
  last_error: string | null;
}

interface Ad {
  id: string;
  status: string;
  values: unknown[];
}

const h = vi.hoisted(() => {
  const state = {
    config: {} as Record<string, unknown>,
    sched: null as Sched | null,
    /** key `${scheduleId}:${runNo}` -> the run row. */
    runs: new Map<string, { status: string; ad_id: string | null }>(),
    ads: [] as Ad[],
    /** make the next user_ads INSERT blow up (a DB fault at publish time). */
    failInsert: false,
    /** pretend an existing 'running' row is older than STALE_RUN_MINUTES. */
    staleRunning: false,
    sent: [] as { chatId: string; text: string }[],
    queries: [] as string[],
  };

  const uuidOf = (values: unknown[]): string | null =>
    (values.find((v) => typeof v === 'string' && UUID_RE.test(v)) as string | undefined) ?? null;

  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    state.queries.push(q);
    const s = state.sched;

    // ── the due list ────────────────────────────────────────────────────────────────────────
    if (q.includes('from scheduled_posts') && q.includes('order by next_run_at')) {
      const due =
        s && s.status === 'active' && s.next_run_at !== null && new Date(s.next_run_at) <= new Date() ? [s] : [];
      return Promise.resolve(due.map((r) => ({ ...r })));
    }

    // ── CLAIM: the PK (schedule_id, run_no) is the idempotency key ───────────────────────────
    if (q.startsWith('insert into scheduled_post_runs')) {
      const id = uuidOf(values)!;
      const runNo = Number(values[1]);
      const key = `${id}:${runNo}`;
      const existing = state.runs.get(key);
      const reclaimable =
        existing !== undefined && (existing.status === 'failed' || (existing.status === 'running' && state.staleRunning));
      if (existing !== undefined && !reclaimable) return Promise.resolve([]);
      state.runs.set(key, { status: 'running', ad_id: existing?.ad_id ?? null });
      return Promise.resolve([{ run_no: runNo }]);
    }

    if (q.startsWith('select status from scheduled_post_runs')) {
      const row = state.runs.get(`${uuidOf(values)}:${Number(values[1])}`);
      return Promise.resolve(row ? [{ status: row.status }] : []);
    }

    // ── the publication itself ──────────────────────────────────────────────────────────────
    if (q.includes('insert into user_ads')) {
      if (state.failInsert) return Promise.reject(new Error('column "promo" does not exist'));
      const id = `ad-${state.ads.length + 1}`;
      state.ads.push({ id, status: 'approved', values });
      return Promise.resolve([{ id }]);
    }

    if (q.startsWith("update scheduled_post_runs set status = 'done'")) {
      const key = `${uuidOf(values)}:${Number(values[values.length - 1])}`;
      const row = state.runs.get(key);
      if (row) state.runs.set(key, { status: 'done', ad_id: String(values[0]) });
      return Promise.resolve([]);
    }

    if (q.startsWith("update scheduled_post_runs set status = 'failed'")) {
      const key = `${uuidOf(values)}:${Number(values[values.length - 1])}`;
      const row = state.runs.get(key);
      if (row) state.runs.set(key, { status: 'failed', ad_id: row.ad_id });
      return Promise.resolve([]);
    }

    // ── take the previous publication down ──────────────────────────────────────────────────
    if (q.includes("update user_ads set status = 'archived'")) {
      const id = uuidOf(values)!;
      const runNo = Number(values[values.length - 1]);
      const archived: unknown[] = [];
      for (const [key, row] of state.runs) {
        const [schedId, no] = key.split(':');
        if (schedId !== id || Number(no) >= runNo || !row.ad_id) continue;
        const ad = state.ads.find((a) => a.id === row.ad_id && a.status === 'approved');
        if (ad) {
          ad.status = 'archived';
          archived.push({ id: ad.id });
        }
      }
      return Promise.resolve(archived);
    }

    // ── schedule bookkeeping ────────────────────────────────────────────────────────────────
    if (q.includes('update scheduled_posts set done_runs')) {
      const runNo = Number(values[0]);
      if (!s || s.done_runs >= runNo) return Promise.resolve([]);
      s.done_runs = runNo;
      s.fail_count = 0;
      s.last_error = null;
      if (runNo >= s.total_runs || s.interval_minutes === null) {
        s.status = 'done';
        s.next_run_at = null;
      } else {
        s.next_run_at = new Date(Date.now() + s.interval_minutes * 60_000).toISOString();
      }
      return Promise.resolve([{ status: s.status, next_run_at: s.next_run_at }]);
    }

    if (q.includes('update scheduled_posts set fail_count')) {
      if (!s) return Promise.resolve([]);
      s.fail_count += 1;
      s.last_error = String(values[0]);
      const maxFails = Number(values[1]);
      if (s.fail_count >= maxFails) s.status = 'failed';
      else s.next_run_at = new Date(Date.now() + 5 * 60_000).toISOString();
      return Promise.resolve([{ status: s.status }]);
    }

    if (q.startsWith('select next_run_at from scheduled_posts')) {
      return Promise.resolve([{ next_run_at: s?.next_run_at ?? null }]);
    }

    if (q.includes('from users')) return Promise.resolve([{ tid: '999' }]);

    return Promise.resolve([]);
  };

  return { state, fakeSql };
});

vi.mock('../core/db.js', () => ({ getSql: () => h.fakeSql }));
vi.mock('../config.js', () => ({
  getConfigNumber: async (k: string, fb: number) => (typeof h.state.config[k] === 'number' ? (h.state.config[k] as number) : fb),
  getConfigBool: async (k: string, fb: boolean) => (typeof h.state.config[k] === 'boolean' ? (h.state.config[k] as boolean) : fb),
  getConfigString: async (_k: string, fb: string) => fb,
}));
vi.mock('../bot/telegram.js', () => ({
  sendMessage: (chatId: string, text: string) => {
    h.state.sent.push({ chatId, text });
    return Promise.resolve({ ok: true, result: { message_id: 1 } });
  },
  maskToken: (s: string) => s,
  getFile: () => Promise.resolve({ ok: false }),
  downloadFile: () => Promise.reject(new Error('unused')),
}));

import { runScheduledPosts, RETRY_AFTER_MINUTES, publishedText } from './run.js';

const PAYLOAD = {
  title: 'Завод в Ансане',
  description: 'Нужны рабочие на завод.',
  contact_raw: '@koreajobs',
  contact_kind: 'telegram',
  work_type: 'factory',
  city_slug: 'ansan',
  city_text: null,
};

function schedule(over: Partial<Sched> = {}): Sched {
  return {
    id: SCHED_ID,
    kind: 'ad',
    payload: PAYLOAD,
    media_id: null,
    created_by: '99999999-8888-7777-6666-555555555555',
    total_runs: 1,
    done_runs: 0,
    notify: true,
    status: 'active',
    next_run_at: new Date(Date.now() - 60_000).toISOString(),
    interval_minutes: null,
    fail_count: 0,
    last_error: null,
    ...over,
  };
}

beforeEach(() => {
  h.state.config = {};
  h.state.sched = schedule();
  h.state.runs = new Map();
  h.state.ads = [];
  h.state.failInsert = false;
  h.state.staleRunning = false;
  h.state.sent = [];
  h.state.queries = [];
});

// ─────────────────────────────────────────────────────────────────────────────
// The ordinary case
// ─────────────────────────────────────────────────────────────────────────────

describe('scheduled worker — publishing', () => {
  it('publishes a due schedule as an approved ad and finishes it', async () => {
    const r = await runScheduledPosts();

    expect(r).toMatchObject({ due: 1, published: 1, failed: 0, finished: 1, skipped: 0 });
    expect(h.state.ads).toHaveLength(1);
    const v = h.state.ads[0]!.values;
    expect(v[AD.title]).toBe(PAYLOAD.title);
    expect(v[AD.workType]).toBe('factory');
    expect(v[AD.citySlug]).toBe('ansan');
    expect(v[AD.contactKind]).toBe('telegram');
    expect(v[AD.promo]).toBe(false);
    // notify=true on an ORDINARY post -> the existing notify worker picks it up (filters + cap).
    expect(v[AD.notifyPending]).toBe(true);

    expect(h.state.runs.get(`${SCHED_ID}:1`)).toEqual({ status: 'done', ad_id: 'ad-1' });
    expect(h.state.sched!.status).toBe('done');
    expect(h.state.sched!.done_runs).toBe(1);
    expect(h.state.sched!.next_run_at).toBeNull();
    // The owner is told, in words.
    expect(h.state.sent[0]!.text).toContain('опубликовано');
  });

  it('«уведомить: нет» publishes without queueing any DM', async () => {
    h.state.sched = schedule({ notify: false });
    await runScheduledPosts();
    expect(h.state.ads[0]!.values[AD.notifyPending]).toBe(false);
  });

  it('nothing due -> nothing happens', async () => {
    h.state.sched = schedule({ next_run_at: new Date(Date.now() + 3_600_000).toISOString() });
    const r = await runScheduledPosts();
    expect(r).toMatchObject({ due: 0, published: 0 });
    expect(h.state.ads).toHaveLength(0);
  });

  it('a cancelled schedule is invisible to the worker', async () => {
    h.state.sched = schedule({ status: 'cancelled' });
    const r = await runScheduledPosts();
    expect(r.due).toBe(0);
    expect(h.state.ads).toHaveLength(0);
  });

  it('the kill switch stops it dead', async () => {
    h.state.config.scheduled_enabled = false;
    const r = await runScheduledPosts();
    expect(r).toMatchObject({ due: 0, published: 0 });
    expect(h.state.queries).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROMO — the rule that must never bend
// ─────────────────────────────────────────────────────────────────────────────

describe('scheduled worker — a paid placement', () => {
  it('is published as promo and is NEVER queued for a DM, even with notify=true', async () => {
    h.state.sched = schedule({ kind: 'promo', notify: true });
    await runScheduledPosts();

    const v = h.state.ads[0]!.values;
    expect(v[AD.promo]).toBe(true);
    // THE point of the whole guard chain: a paid ad never enters the notify queue.
    expect(v[AD.notifyPending]).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IDEMPOTENCY
// ─────────────────────────────────────────────────────────────────────────────

describe('scheduled worker — idempotency', () => {
  it('a duplicated tick publishes nothing extra', async () => {
    await runScheduledPosts();
    const after = await runScheduledPosts();

    expect(h.state.ads).toHaveLength(1); // still exactly one card
    expect(after).toMatchObject({ due: 0, published: 0 });
  });

  it('a run already claimed by a concurrent invocation is skipped, not published again', async () => {
    // Another invocation is mid-flight: the run row exists and is fresh.
    h.state.runs.set(`${SCHED_ID}:1`, { status: 'running', ad_id: null });

    const r = await runScheduledPosts();

    expect(r).toMatchObject({ due: 1, published: 0, skipped: 1 });
    expect(h.state.ads).toHaveLength(0);
  });

  it('a run that PUBLISHED but lost its bookkeeping is healed from the journal, never republished', async () => {
    // The publication happened; the schedule's counters did not survive (function died right after).
    h.state.runs.set(`${SCHED_ID}:1`, { status: 'done', ad_id: 'ad-old' });

    const r = await runScheduledPosts();

    expect(h.state.ads).toHaveLength(0); // no second card
    expect(r).toMatchObject({ published: 0, skipped: 1, finished: 1 });
    expect(h.state.sched!.done_runs).toBe(1);
    expect(h.state.sched!.status).toBe('done');
  });

  it('a stale «running» left by a dead invocation IS re-claimable', async () => {
    h.state.runs.set(`${SCHED_ID}:1`, { status: 'running', ad_id: null });
    h.state.staleRunning = true;

    const r = await runScheduledPosts();

    expect(r.published).toBe(1);
    expect(h.state.ads).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REPEATS — new card, previous one taken down
// ─────────────────────────────────────────────────────────────────────────────

describe('scheduled worker — repeats', () => {
  it('publishes a NEW card and archives the previous publication (no re-dating, no duplicates)', async () => {
    h.state.sched = schedule({ total_runs: 3, done_runs: 1, interval_minutes: 1440 });
    h.state.runs.set(`${SCHED_ID}:1`, { status: 'done', ad_id: 'ad-prev' });
    h.state.ads.push({ id: 'ad-prev', status: 'approved', values: [] });

    const r = await runScheduledPosts();

    expect(r).toMatchObject({ published: 1, finished: 0 });
    // A brand-new row, and the old one is off the feed.
    expect(h.state.ads.map((a) => [a.id, a.status])).toEqual([
      ['ad-prev', 'archived'],
      ['ad-2', 'approved'],
    ]);
    // Still active, with the next moment set.
    expect(h.state.sched!.status).toBe('active');
    expect(h.state.sched!.done_runs).toBe(2);
    expect(h.state.sched!.next_run_at).not.toBeNull();
    expect(h.state.sent[0]!.text).toContain('Прошлая публикация снята');
  });

  it('the LAST run of a repeat closes the schedule', async () => {
    h.state.sched = schedule({ total_runs: 2, done_runs: 1, interval_minutes: 1440 });
    h.state.runs.set(`${SCHED_ID}:1`, { status: 'done', ad_id: 'ad-prev' });
    h.state.ads.push({ id: 'ad-prev', status: 'approved', values: [] });

    const r = await runScheduledPosts();

    expect(r.finished).toBe(1);
    expect(h.state.sched!.status).toBe('done');
    expect(h.state.sched!.next_run_at).toBeNull();
  });

  it('publishedText says the previous card came down, and names the next moment', () => {
    const text = publishedText('Завод', 2, 5, 'ad', new Date('2026-08-02T00:00:00.000Z'));
    expect(text).toContain('(2 из 5)');
    expect(text).toContain('Прошлая публикация снята');
    expect(text).toContain('2 августа, 09:00');
    // A single publication mentions neither.
    const once = publishedText('Завод', 1, 1, 'promo', null);
    expect(once).toContain('Реклама опубликовано');
    expect(once).not.toContain('Прошлая публикация');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FAILURES
// ─────────────────────────────────────────────────────────────────────────────

describe('scheduled worker — failures', () => {
  it('records the reason, keeps the schedule and retries later', async () => {
    h.state.failInsert = true;

    const r = await runScheduledPosts();

    expect(r).toMatchObject({ published: 0, failed: 1 });
    expect(h.state.runs.get(`${SCHED_ID}:1`)!.status).toBe('failed'); // re-claimable next tick
    expect(h.state.sched!.status).toBe('active');
    expect(h.state.sched!.fail_count).toBe(1);
    expect(h.state.sched!.last_error).toContain('promo');
    expect(new Date(h.state.sched!.next_run_at!).getTime()).toBeGreaterThan(Date.now());
    expect(h.state.sent[0]!.text).toContain(`через ${RETRY_AFTER_MINUTES} минут`);
  });

  it('parks the schedule as failed after scheduled_max_fails attempts and says so', async () => {
    h.state.failInsert = true;
    h.state.config.scheduled_max_fails = 2;
    h.state.sched = schedule({ fail_count: 1 });

    await runScheduledPosts();

    expect(h.state.sched!.status).toBe('failed');
    expect(h.state.sent[0]!.text).toContain('больше не пробую');
  });

  it('a failed run is retried on the next tick (the run row is re-claimable)', async () => {
    h.state.failInsert = true;
    await runScheduledPosts();

    h.state.failInsert = false;
    h.state.sched!.next_run_at = new Date(Date.now() - 1000).toISOString();
    const second = await runScheduledPosts();

    expect(second.published).toBe(1);
    expect(h.state.ads).toHaveLength(1);
  });

  it('a broken payload cannot crash the worker (defaults are used)', async () => {
    h.state.sched = schedule({ payload: null });
    const r = await runScheduledPosts();
    expect(r.published).toBe(1);
    expect(h.state.ads[0]!.values[AD.workType]).toBe('other');
  });

  it('a jsonb payload arriving as a STRING is parsed', async () => {
    h.state.sched = schedule({ payload: JSON.stringify(PAYLOAD) });
    await runScheduledPosts();
    expect(h.state.ads[0]!.values[AD.title]).toBe(PAYLOAD.title);
  });
});
